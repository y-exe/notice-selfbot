const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    startYoutubeRssMonitor,
    checkYoutubeTarget,
} = require('../src/youtube/rss');
const { createWebsubServer } = require('../src/youtube/websub');
const { formatYoutubeMessage } = require('../src/youtube/notify');

test('再起動と取得障害の復旧時は通知を出さず、その後の新着だけを通知する', async (t) => {
    let ids = ['old', 'backlog1', 'backlog2'];
    let failing = false;
    let next;
    const state = {
        lastYoutubeVideoIds: { UCexample: 'old' },
        youtubeSeenVideoIds: ['old'],
    };
    const messages = [];
    const previousKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = 'test-key';
    const stop = startYoutubeRssMonitor({
        config: {
            YOUTUBE_UPDATES: [
                { channelId: 'UCexample', roleId: 'youtube-role' },
            ],
        },
        state,
        saveState: () => {},
        sendNotification: async (message) => messages.push(message),
        logger: { log() {}, warn() {}, error() {} },
        setTimeoutImpl: (callback) => {
            next = callback;
            return 1;
        },
        clearTimeoutImpl: () => {},
        fetchImpl: async (url) => {
            if (failing) throw new Error('offline');
            if (new URL(url).pathname.endsWith('/playlistItems'))
                return {
                    ok: true,
                    json: async () => ({
                        items: ids.map((id, i) => ({
                            contentDetails: {
                                videoId: id,
                                videoPublishedAt: new Date(
                                    i * 1000,
                                ).toISOString(),
                            },
                            snippet: { title: id },
                        })),
                    }),
                };
            return { ok: true, json: async () => ({ items: [] }) };
        },
    });
    t.after(() => {
        stop();
        if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
        else process.env.YOUTUBE_API_KEY = previousKey;
    });
    await new Promise(setImmediate);
    assert.equal(messages.length, 0);
    assert.ok(state.youtubeSeenVideoIds.includes('backlog2'));
    ids.push('new1');
    await next();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^<@&youtube-role>/);
    failing = true;
    await next();
    ids.push('during-outage1', 'during-outage2');
    failing = false;
    await next();
    assert.equal(messages.length, 1, '復旧時の溜まった分は通知しない');
    ids.push('new2');
    await next();
    assert.equal(messages.length, 2);
    assert.ok(messages[1].endsWith('/new2'));
    await next();
    assert.equal(messages.length, 2, '同じ新着を再通知しない');
});

test('基準更新時はRSSの条件付き取得をせず、未取得の過去分を既読にする', async () => {
    const state = {
        lastYoutubeVideoIds: { UCexample: 'old' },
        youtubeSeenVideoIds: ['old'],
        youtubeFeedMeta: {
            UCexample: { etag: 'cached', lastModified: 'cached' },
        },
    };
    await checkYoutubeTarget({
        target: { channelId: 'UCexample' },
        state,
        baselineOnly: true,
        saveState: () => {},
        send: async () => assert.fail('基準更新では送信しない'),
        logger: { log() {} },
        fetchImpl: async (url, options) => {
            assert.equal(options.headers['if-none-match'], undefined);
            assert.equal(options.headers['if-modified-since'], undefined);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                text: async () =>
                    '<feed><entry><yt:videoId>backlog</yt:videoId><published>2026-10-01T00:00:00Z</published></entry></feed>',
            };
        },
    });
    assert.ok(state.youtubeSeenVideoIds.includes('backlog'));
});

test('WebSubの遅延した過去動画は通知せず、起動後の新規投稿だけを通知する', async (t) => {
    const since = Date.parse('2026-10-22T12:00:00Z');
    const messages = [];
    const state = {
        lastYoutubeVideoIds: { UCexample: 'baseline' },
        youtubeSeenVideoIds: ['baseline'],
    };
    const server = createWebsubServer({
        targets: [{ channelId: 'UCexample' }],
        state,
        notificationSince: since,
        saveState: () => {},
        send: async (m) => messages.push(m),
        logger: { log() {}, error() {} },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const body = (id, date) =>
        `<feed><entry><yt:videoId>${id}</yt:videoId><published>${date}</published></entry></feed>`;
    const post = (xml) =>
        fetch(
            `http://127.0.0.1:${server.address().port}/youtube/websub/UCexample`,
            { method: 'POST', body: xml },
        );
    assert.equal((await post(body('old', '2026-10-01T00:00:00Z'))).status, 204);
    assert.equal((await post(body('unknown', 'invalid'))).status, 204);
    assert.equal(messages.length, 0);
    assert.equal((await post(body('new', '2026-10-22T12:01:00Z'))).status, 204);
    assert.equal(messages.length, 1);
});

test('YouTube通知のメンションはYouTubeの設定だけを使う', () => {
    const message = formatYoutubeMessage(
        { roleId: 'youtube-role' },
        { videoId: 'test', title: 'テスト' },
    );
    assert.ok(message.startsWith('<@&youtube-role>'));
    assert.ok(!message.includes('twitter-role'));
});
