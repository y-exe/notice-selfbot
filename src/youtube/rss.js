const { feedUrl, parseFeedEntries, sameChannelId, isPlaceholderFeed, YOUTUBE_USER_AGENT } = require('./feed');
const { fetchLatestVideos } = require('./api');
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
        `?part=snippet&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`;
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
    baselineOnly = false,
}) {
    if (!target.channelId) {
        logger.warn?.(
            `YouTube監視対象にchannelIdがありません: ${target.handle || '(不明)'}`,
        );
        return;
    }
    ensureYoutubeState(state);
    // Data APIを一次取得に使う。API失敗時のみRSSにフォールバックする。
    let entries = null;
    if (apiKey) {
        try {
            const videos = await fetchLatestVideos({
                channelId: target.channelId,
                apiKey,
                fetchImpl,
            });
            if (!videos.length)
                throw new Error('結果が空でした');
            entries = sortByPublished(videos);
        } catch (error) {
            entries = null;
            logger.warn?.(
                `YouTube Data APIの取得に失敗したためRSSで再試行します (${target.handle || target.channelId}): ${error.message}`,
            );
        }
    }
    if (!entries) {
        if (!state.youtubeFeedMeta || typeof state.youtubeFeedMeta !== 'object')
            state.youtubeFeedMeta = {};
        const key = feedMetaKey(target);
        const meta = state.youtubeFeedMeta[key] || {};
        const feed = await fetchFeed(target.channelId, {
            fetchImpl,
            etag: baselineOnly ? undefined : meta.etag,
            lastModified: baselineOnly ? undefined : meta.lastModified,
        });
        if (feed.notModified) return;
        if (isPlaceholderFeed(feed.xml))
            throw new Error(
                `YouTubeから仮フィードが返されました (${target.handle || target.channelId})。レート制限の可能性があり次回再試行します`,
            );
        if (!feed.xml || !feed.xml.includes('<feed'))
            throw new Error(
                `YouTubeフィードの形式が不正です (${target.handle || target.channelId})。次回再試行します`,
            );
        if (feed.etag || feed.lastModified) {
            state.youtubeFeedMeta[key] = {
                ...(feed.etag ? { etag: feed.etag } : {}),
                ...(feed.lastModified ? { lastModified: feed.lastModified } : {}),
            };
        }
        const parsed = parseFeedEntries(feed.xml);
        entries = sortByPublished(
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
    }
    if (!entries.length) {
        saveState();
        return;
    }
    // 初回観測は最新を基準として保存だけし、遡って通知しない。
    if (baselineOnly || !state.lastYoutubeVideoIds[channelKey(target)]) {
        const latest = entries[entries.length - 1];
        state.lastYoutubeVideoIds[channelKey(target)] = latest.videoId;
        for (const entry of entries)
            if (!state.youtubeSeenVideoIds.includes(entry.videoId))
                state.youtubeSeenVideoIds.push(entry.videoId);
        state.youtubeSeenVideoIds = state.youtubeSeenVideoIds.slice(-1000);
        saveState();
        logger.log?.(
            `YouTube監視の基準を更新しました（過去分は通知しません）: ${target.handle || target.channelId}`,
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
    let enriched = fresh;
    try {
        enriched = await enrichVideos(fresh, { apiKey, fetchImpl });
    } catch (error) {
        logger.warn?.(
            `YouTube動画の詳細を取得できないため取得済み情報で通知します (${target.handle || target.channelId}): ${error.message}`,
        );
    }
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
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
}) {
    const { youtubeTargets } = require('../config');
    const targets = youtubeTargets(config);
    const baselineNeeded = new Set(targets.map(channelKey));
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
                    baselineOnly: baselineNeeded.has(channelKey(target)),
                });
                baselineNeeded.delete(channelKey(target));
            } catch (error) {
                baselineNeeded.add(channelKey(target));
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
        timer = setTimeoutImpl(async () => {
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
        clearTimeoutImpl(timer);
    };
}

module.exports = {
    fetchFeed,
    enrichVideos,
    checkYoutubeTarget,
    startYoutubeRssMonitor,
};
