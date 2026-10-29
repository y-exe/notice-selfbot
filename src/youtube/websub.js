const http = require('node:http');
const crypto = require('node:crypto');
const { enrichVideos } = require('./api');
const {
    feedUrl,
    parseFeedEntries,
    sameChannelId,
    YOUTUBE_HUB_URL,
} = require('./feed');
const {
    channelKey,
    ensureYoutubeState,
    sendYoutubeVideo,
} = require('./notify');

const DEFAULT_LEASE_SECONDS = 432000; // 5日
const MAX_BODY_BYTES = 262144;

function callbackUrlFor(baseUrl, channelId) {
    return `${baseUrl.replace(/\/+$/, '')}/youtube/websub/${encodeURIComponent(channelId)}`;
}

async function subscribeChannel({
    channelId,
    callback,
    secret,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    fetchImpl = fetch,
    hubUrl = YOUTUBE_HUB_URL,
}) {
    const body = new URLSearchParams({
        'hub.callback': callback,
        'hub.topic': feedUrl(channelId),
        'hub.verify': 'async',
        'hub.mode': 'subscribe',
        'hub.lease_seconds': String(leaseSeconds),
    });
    if (secret) body.set('hub.secret', secret);
    const res = await fetchImpl(hubUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok && res.status !== 202)
        throw new Error(
            `WebSub登録に失敗しました (${channelId}): HTTP ${res.status}`,
        );
}

function signatureValid(secret, signatureHeader, body) {
    if (!secret || !signatureHeader) return true;
    for (const algorithm of ['sha256', 'sha1']) {
        const prefix = `${algorithm}=`;
        if (!signatureHeader.startsWith(prefix)) continue;
        const expected =
            algorithm === 'sha256'
                ? crypto.createHmac('sha256', secret).update(body).digest('hex')
                : crypto.createHmac('sha1', secret).update(body).digest();
        const actual = signatureHeader.slice(prefix.length);
        if (
            expected.length === actual.length &&
            crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
        )
            return true;
        return false;
    }
    return true;
}

function createWebsubServer({
    targets,
    state,
    saveState,
    send,
    isReady = () => true,
    secret,
    logger = console,
    notificationSince = Date.now(),
    apiKey,
    fetchImpl = fetch,
}) {
    const findTarget = (channelId) =>
        targets.find(
            (t) => t && t.enabled !== false && t.channelId === channelId,
        );
    let queue = Promise.resolve();

    async function processBody(target, xml) {
        const entries = parseFeedEntries(xml)
            .filter(
                (entry) =>
                    !entry.channelId ||
                    sameChannelId(entry.channelId, target.channelId),
            )
            .sort((a, b) =>
                (a.published || a.updated || '').localeCompare(
                    b.published || b.updated || '',
                ),
            );
        if (!entries.length) return;
        ensureYoutubeState(state);
        const oldEntries = entries.filter((entry) => {
            const published = Date.parse(entry.published);
            return !Number.isFinite(published) || published < notificationSince;
        });
        for (const entry of oldEntries) {
            if (!state.youtubeSeenVideoIds.includes(entry.videoId))
                state.youtubeSeenVideoIds.push(entry.videoId);
        }
        if (oldEntries.length) {
            state.youtubeSeenVideoIds = state.youtubeSeenVideoIds.slice(-1000);
            saveState();
        }
        // 初回通知は最新を基準として保存だけし、遡って通知しない。
        if (
            !state.lastYoutubeVideoIds[channelKey(target)] &&
            !state.youtubeBaselineInitialized[channelKey(target)]
        ) {
            state.youtubeBaselineInitialized[channelKey(target)] = true;
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
        let videos = entries.filter(
            (video) => !state.youtubeSeenVideoIds.includes(video.videoId),
        );
        if (target.videosOnly)
            videos = await enrichVideos(videos, {
                apiKey,
                fetchImpl,
                includeLiveStreamingDetails: true,
            });
        for (const video of videos)
            await sendYoutubeVideo({
                target,
                video,
                state,
                saveState,
                send,
                logger,
            });
    }

    return http.createServer(async (req, res) => {
        const reply = (code, message) => {
            res.writeHead(code, { 'Content-Type': 'text/plain' });
            res.end(message);
        };
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            return reply(400, 'Bad request');
        }
        const match = url.pathname.match(/^\/youtube\/websub\/([^/]+)$/);
        if (!match) return reply(404, 'Not found');
        const channelId = decodeURIComponent(match[1]);
        const target = findTarget(channelId);

        // 購読確認 (hub.challengeの折り返し)
        if (req.method === 'GET') {
            const mode = url.searchParams.get('hub.mode');
            const topic = url.searchParams.get('hub.topic');
            const challenge = url.searchParams.get('hub.challenge');
            if (
                !target ||
                (mode !== 'subscribe' && mode !== 'unsubscribe') ||
                topic !== feedUrl(channelId) ||
                !challenge
            )
                return reply(404, 'Unknown subscription');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(challenge);
            return;
        }

        if (req.method !== 'POST') return reply(405, 'POST required');
        if (!target) return reply(404, 'Unknown channel');
        if (!isReady()) return reply(503, 'Discord unavailable');
        const chunks = [];
        let size = 0;
        try {
            for await (const chunk of req) {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    reply(413, 'Payload too large');
                    req.resume();
                    return;
                }
                chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks);
            const signature =
                req.headers['x-hub-signature'] ||
                req.headers['x-hub-signature-256'];
            if (secret && signature && !signatureValid(secret, signature, raw))
                return reply(401, 'Bad signature');
            const pending = queue.then(() =>
                processBody(target, raw.toString('utf8')),
            );
            queue = pending.catch(() => {});
            await pending;
            reply(204, '');
        } catch (error) {
            logger.error?.('YouTube通知の処理に失敗しました:', error.message);
            if (!res.headersSent) reply(500, 'Notification failed');
        }
    });
}

async function subscribeAll({
    targets,
    baseUrl,
    secret,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    fetchImpl = fetch,
    hubUrl = YOUTUBE_HUB_URL,
    logger = console,
}) {
    for (const target of targets) {
        if (!target.channelId) continue;
        const callback = callbackUrlFor(baseUrl, target.channelId);
        await subscribeChannel({
            channelId: target.channelId,
            callback,
            secret,
            leaseSeconds,
            fetchImpl,
            hubUrl,
        });
        logger.log?.(
            `WebSubに登録しました: ${target.handle || target.channelId}`,
        );
    }
}

function startWebsubRenewal(options) {
    const leaseSeconds = options.leaseSeconds || DEFAULT_LEASE_SECONDS;
    let timer;
    let stopped = false;
    const renew = () =>
        subscribeAll(options).catch((error) =>
            (options.logger || console).error?.(
                'WebSubの再登録に失敗しました:',
                error.message,
            ),
        );
    timer = setInterval(
        renew,
        Math.max(3600, Math.floor(leaseSeconds * 0.8)) * 1000,
    );
    if (timer.unref) timer.unref();
    return () => {
        stopped = true;
        clearInterval(timer);
        void stopped;
    };
}

module.exports = {
    DEFAULT_LEASE_SECONDS,
    callbackUrlFor,
    subscribeChannel,
    signatureValid,
    createWebsubServer,
    subscribeAll,
    startWebsubRenewal,
};
