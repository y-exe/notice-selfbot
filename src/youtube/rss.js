const { feedUrl, parseFeedEntries, sameChannelId, YOUTUBE_USER_AGENT } = require('./feed');
const { channelKey, ensureYoutubeState, sendYoutubeVideo } = require('./notify');

function feedMetaKey(target) {
    return target.channelId || target.handle;
}

async function fetchFeed(channelId, { fetchImpl = fetch, etag, lastModified } = {}) {
    const headers = { 'user-agent': YOUTUBE_USER_AGENT };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;
    const res = await fetchImpl(feedUrl(channelId), { headers });
    if (res.status === 304) return { notModified: true };
    if (!res.ok)
        throw new Error(`YouTubeフィードの取得に失敗しました: HTTP ${res.status}`);
    return {
        xml: await res.text(),
        etag: res.headers.get('etag') || undefined,
        lastModified: res.headers.get('last-modified') || undefined,
    };
}

// Data APIキーがある場合のみ、ライブ状態と正確なタイトルで補強する。
// キーがなければRSSの情報のまま通知する。
async function enrichVideos(videos, { apiKey, fetchImpl = fetch } = {}) {
    if (!apiKey || !videos.length) return videos;
    const ids = [...new Set(videos.map((v) => v.videoId))].slice(0, 50);
    const url =
        'https://www.googleapis.com/youtube/v3/videos' +
        `?part=snippet,liveBroadcastDetails&id=${ids.join(',')}&key=${apiKey}`;
    const res = await fetchImpl(url, {
        headers: { 'user-agent': YOUTUBE_USER_AGENT },
    });
    if (!res.ok)
        throw new Error(`YouTube Data APIの取得に失敗しました: HTTP ${res.status}`);
    const data = await res.json();
    const byId = {};
    for (const item of data.items || []) {
        const broadcast = item.snippet && item.snippet.liveBroadcastContent;
        byId[item.id] = {
            title:
                (item.snippet && item.snippet.title) || undefined,
            kind:
                broadcast === 'live'
                    ? 'live'
                    : broadcast === 'upcoming'
                      ? 'upcoming'
                      : 'video',
        };
    }
    return videos.map((video) => ({
        ...video,
        title: (byId[video.videoId] && byId[video.videoId].title) || video.title,
        kind: (byId[video.videoId] && byId[video.videoId].kind) || 'video',
    }));
}

function sortByPublished(entries) {
    return [...entries].sort((a, b) =>
        (a.published || a.updated || '').localeCompare(
            b.published || b.updated || '',
        ),
    );
}

async function checkYoutubeTarget({
    target,
    state,
    saveState,
    send,
    fetchImpl = fetch,
    apiKey,
    logger = console,
}) {
    if (!target.channelId) {
        logger.warn?.(
            `YouTube監視対象にchannelIdがありません: ${target.handle || '(不明)'}`,
        );
        return;
    }
    ensureYoutubeState(state);
    if (!state.youtubeFeedMeta || typeof state.youtubeFeedMeta !== 'object')
        state.youtubeFeedMeta = {};
    const key = feedMetaKey(target);
    const meta = state.youtubeFeedMeta[key] || {};
    const feed = await fetchFeed(target.channelId, {
        fetchImpl,
        etag: meta.etag,
        lastModified: meta.lastModified,
    });
    if (feed.notModified) return;
    if (feed.etag || feed.lastModified) {
        state.youtubeFeedMeta[key] = {
            ...(feed.etag ? { etag: feed.etag } : {}),
            ...(feed.lastModified ? { lastModified: feed.lastModified } : {}),
        };
    }
    const parsed = parseFeedEntries(feed.xml);
    const entries = sortByPublished(
        parsed.filter(
            (entry) =>
                !entry.channelId || sameChannelId(entry.channelId, target.channelId),
        ),
    );
    if (parsed.length && !entries.length) {
        logger.warn?.(
            `YouTubeフィードの全件が別チャンネル扱いで除外されました: ${target.handle || target.channelId}`,
        );
    }
    if (!entries.length) {
        saveState();
        return;
    }
    // 初回観測は最新を基準として保存だけし、遡って通知しない。
    if (!state.lastYoutubeVideoIds[channelKey(target)]) {
        const latest = entries[entries.length - 1];
        state.lastYoutubeVideoIds[channelKey(target)] = latest.videoId;
        for (const entry of entries)
            if (!state.youtubeSeenVideoIds.includes(entry.videoId))
                state.youtubeSeenVideoIds.push(entry.videoId);
        state.youtubeSeenVideoIds = state.youtubeSeenVideoIds.slice(-1000);
        saveState();
        logger.log?.(
            `YouTube監視を開始しました: ${target.handle || target.channelId} (基準 ${latest.videoId})`,
        );
        return;
    }
    const fresh = entries.filter(
        (entry) => !state.youtubeSeenVideoIds.includes(entry.videoId),
    );
    if (!fresh.length) {
        saveState();
        return;
    }
    const enriched = await enrichVideos(fresh, { apiKey, fetchImpl });
    for (const video of enriched) {
        try {
            await sendYoutubeVideo({ target, video, state, saveState, send, logger });
        } catch (error) {
            logger.error?.(
                `YouTube通知に失敗しました (${video.videoId}):`,
                error.message,
            );
        }
    }
}

function startYoutubeRssMonitor({
    config,
    state,
    saveState,
    sendNotification,
    fetchImpl = fetch,
    logger = console,
}) {
    const { youtubeTargets } = require('../config');
    const targets = youtubeTargets(config);
    let timer;
    let stopped = false;
    const apiKey = process.env.YOUTUBE_API_KEY || config.YOUTUBE_API_KEY;

    async function checkAll() {
        for (const target of targets) {
            try {
                await checkYoutubeTarget({
                    target,
                    state,
                    saveState,
                    send: sendNotification,
                    fetchImpl,
                    apiKey,
                    logger,
                });
            } catch (error) {
                logger.error?.(
                    `YouTubeフィードの取得に失敗しました (${target.handle || target.channelId}):`,
                    error.message,
                );
            }
        }
    }

    function scheduleNext() {
        const minSeconds =
            config.YOUTUBE_CHECK_INTERVAL_MIN_SECONDS ||
            config.CHECK_INTERVAL_MIN_SECONDS ||
            180;
        const maxSeconds =
            config.YOUTUBE_CHECK_INTERVAL_MAX_SECONDS ||
            config.CHECK_INTERVAL_MAX_SECONDS ||
            300;
        const intervalSeconds =
            Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
        logger.log?.(`次のYouTube取得は${intervalSeconds}秒後です。`);
        timer = setTimeout(async () => {
            try {
                await checkAll();
            } catch (error) {
                logger.error?.('YouTubeの定期取得に失敗しました:', error.message);
            } finally {
                if (!stopped) scheduleNext();
            }
        }, intervalSeconds * 1000);
    }

    checkAll().finally(() => {
        if (!stopped) scheduleNext();
    });
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}

module.exports = {
    fetchFeed,
    enrichVideos,
    checkYoutubeTarget,
    startYoutubeRssMonitor,
};
