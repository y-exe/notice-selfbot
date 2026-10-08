const http = require('node:http');

function parseTweet(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const strings = [];
    function walk(value) {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object')
            Object.values(value).forEach(walk);
    }
    walk(payload);
    for (const value of strings) {
        const match = value.match(
            /^(?:https:\/\/(?:www\.)?(?:x\.com|twitter\.com))?\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/,
        );
        if (match) return { username: match[1], id: match[2] };
    }
    return null;
}

function createPushServer({
    targets,
    state,
    saveState,
    send,
    isReady,
    logger = console,
}) {
    let queue = Promise.resolve();
    async function processPayload(payload) {
        const tweet = parseTweet(payload);
        if (!tweet) {
            if (Object.keys(payload).length)
                logger.warn(
                    'X通知に対応する投稿URLがありません。キー: ' +
                        Object.keys(payload).join(', '),
                );
            return;
        }
        const target = targets.find(
            (t) =>
                t &&
                t.enabled !== false &&
                (t.username || t.nitterUsername || '').toLowerCase() ===
                    tweet.username.toLowerCase(),
        );
        if (!target) return;
        const username = target.username || target.nitterUsername;
        state.twitterPushSeenIds ||= [];
        if (
            state.twitterPushSeenIds.includes(tweet.id) ||
            state.lastTweetGuids[username] === tweet.id
        )
            return;
        const mention = target.roleId ? `<@&${target.roleId}> ` : '';
        await send(
            `${mention}**${username}**さんが新しいツイートを投稿しました！\nhttps://fxtwitter.com/${username}/status/${tweet.id}`,
        );
        state.twitterPushSeenIds.push(tweet.id);
        state.twitterPushSeenIds = state.twitterPushSeenIds.slice(-1000);
        state.lastTweetGuids[username] = tweet.id;
        saveState();
        logger.log?.(`X通知を送信しました: ${username}/${tweet.id}`);
    }
    return http.createServer(async (req, res) => {
        const reply = (code, message) => {
            res.writeHead(code, { 'Content-Type': 'text/plain' });
            res.end(message);
        };
        if (req.url !== '/twitter/push') return reply(404, 'Not found');
        if (req.method !== 'POST') return reply(405, 'POST required');
        if (!isReady()) return reply(503, 'Discord unavailable');
        const chunks = [];
        let size = 0;
        try {
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 65536) {
                    reply(413, 'Payload too large');
                    req.resume();
                    return;
                }
                chunks.push(chunk);
            }
            let payload;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return reply(400, 'Invalid JSON');
            }
            if (
                !payload ||
                typeof payload !== 'object' ||
                Array.isArray(payload)
            )
                return reply(400, 'Object required');
            const pending = queue.then(() => processPayload(payload));
            queue = pending.catch(() => {});
            await pending;
            reply(204, '');
        } catch (error) {
            logger.error('X通知の処理に失敗しました:', error.message);
            if (!res.headersSent) reply(500, 'Notification failed');
        }
    });
}

module.exports = { parseTweet, createPushServer };
