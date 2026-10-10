const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    feedUrl,
    shortUrl,
    sameChannelId,
    isPlaceholderFeed,
    parseFeedEntries,
    resolveChannelIdFromHtml,
} = require('../src/youtube/feed');
const {
    formatYoutubeMessage,
    sendYoutubeVideo,
} = require('../src/youtube/notify');
const {
    checkYoutubeTarget,
    enrichVideos,
} = require('../src/youtube/rss');
const {
    fetchLatestVideos,
    uploadsPlaylistId,
} = require('../src/youtube/api');
const {
    callbackUrlFor,
    signatureValid,
    createWebsubServer,
} = require('../src/youtube/websub');
const { youtubeTargets } = require('../src/config');
const { createStateStore } = require('../src/storage/state');

const CHANNEL_A = 'UCdd64FlemydZH2Xq1PsmCAA';
const CHANNEL_B = 'UCco1wyybgwsOnfHxyW3aXNQ';

function sampleFeed(channelId, videos) {
    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">' +
        `<yt:channelId>${channelId}</yt:channelId>` +
        videos
            .map(
                (v) =>
                    '<entry>' +
                    `<id>yt:video:${v.id}</id>` +
                    `<yt:videoId>${v.id}</yt:videoId>` +
                    `<yt:channelId>${channelId}</yt:channelId>` +
                    `<title>${v.title}</title>` +
                    `<published>${v.published}</published>` +
                    `<updated>${v.published}</updated>` +
                    '<author><name>Test</name></author>' +
                    '</entry>',
            )
            .join('') +
        '</feed>'
    );
}

function stubFetch(xmlByUrl, apiById = {}, playlistById = {}) {
    return async (url) => {
        const urlString = String(url);
        if (urlString.includes('googleapis.com/youtube/v3/playlistItems')) {
            const playlistId = new URL(urlString).searchParams.get('playlistId');
            if (!(playlistId in playlistById))
                return { ok: false, status: 500, json: async () => ({}) };
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    items: playlistById[playlistId].map((v) => ({
                        snippet: {
                            title: v.title,
                            publishedAt: v.published,
                            channelTitle: 'Test',
                        },
                        contentDetails: {
                            videoId: v.id,
                            videoPublishedAt: v.published,
                        },
                    })),
                }),
            };
        }
        if (String(url).includes('googleapis.com')) {
            const ids = new URL(url).searchParams.get('id').split(',');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    items: ids.map((id) => ({
                        id,
                        snippet: {
                            title: (apiById[id] && apiById[id].title) || `t-${id}`,
                            liveBroadcastContent:
                                (apiById[id] && apiById[id].broadcast) || 'none',
                        },
                    })),
                }),
            };
        }
        const key = String(url);
        const xml = xmlByUrl[key];
        if (!(key in xmlByUrl)) return { ok: false, status: 404, text: async () => '' };
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => xml,
        };
    };
}

test('feed URLとyoutu.be短縮URLの形式', () => {
    assert.equal(
        feedUrl(CHANNEL_A),
        `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_A}`,
    );
    assert.equal(shortUrl('dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ');
});

test('Atomフィードをパースし実体参照を戻す', () => {
    const entries = parseFeedEntries(
        sampleFeed(CHANNEL_A, [
            { id: 'VID1', title: 'A &amp; B', published: '2026-10-09T00:00:00+00:00' },
            { id: 'VID2', title: 'C', published: '2026-10-10T00:00:00+00:00' },
        ]),
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0].videoId, 'VID1');
    assert.equal(entries[0].title, 'A & B');
    assert.equal(entries[0].channelId, CHANNEL_A);
    assert.deepEqual(parseFeedEntries('not xml'), []);
});

test('フィードのチャンネルIDはUC接頭辞なしでも照合する', async () => {
    assert.equal(sameChannelId(CHANNEL_A, CHANNEL_A), true);
    assert.equal(sameChannelId(CHANNEL_A, CHANNEL_A.replace(/^UC/, '')), true);
    assert.equal(sameChannelId(CHANNEL_A, CHANNEL_B), false);
    assert.equal(sameChannelId('', CHANNEL_A), false);
    // 実フィードはentryのyt:channelIdからUCが落ちる
    const stripped = CHANNEL_A.replace(/^UC/, '');
    const xml = sampleFeed(CHANNEL_A, [
        { id: 'V1', title: 'v1', published: '2026-10-10T00:00:00+00:00' },
    ]).replaceAll(`<yt:channelId>${CHANNEL_A}</yt:channelId>`, `<yt:channelId>${stripped}</yt:channelId>`);
    const parsed = parseFeedEntries(xml);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].channelId, stripped);
    const state = {};
    const messages = [];
    await checkYoutubeTarget({
        target: { handle: 'H', channelId: CHANNEL_A },
        state,
        saveState: () => {},
        send: async (m) => messages.push(m),
        fetchImpl: stubFetch({ [feedUrl(CHANNEL_A)]: xml }),
        logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal(state.lastYoutubeVideoIds[CHANNEL_A], 'V1');
});

test('仮フィード・不正形式は異常扱いで再試行させる', async () => {
    const placeholder =
        '<?xml version="1.0" encoding="utf-8"?>\n<!--\n  This is a static file.\n-->\n' +
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>YouTube video feed</title></feed>';
    assert.equal(isPlaceholderFeed(placeholder), true);
    assert.equal(isPlaceholderFeed(sampleFeed(CHANNEL_A, [])), false);
    assert.equal(isPlaceholderFeed(''), false);
    const state = {};
    const run = (xml) =>
        checkYoutubeTarget({
            target: { handle: 'H', channelId: CHANNEL_A },
            state,
            saveState: () => {},
            send: async () => {},
            fetchImpl: stubFetch({ [feedUrl(CHANNEL_A)]: xml }),
            logger: { log() {}, warn() {}, error() {} },
        });
    await assert.rejects(run(placeholder), /仮フィード/);
    await assert.rejects(run(''), /形式が不正/);
    await assert.rejects(run('<html>not a feed</html>'), /形式が不正/);
    assert.deepEqual(state.lastYoutubeVideoIds, {});
});

test('ハンドルページはcanonicalのIDを優先する', () => {
    const html =
        '<html><head>' +
        `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_A}">` +
        `<meta property="og:title" content="x">` +
        '</head><body>' +
        `"channelId":"${CHANNEL_B}"` + // 関連ch等の混入
        '</body></html>';
    assert.equal(resolveChannelIdFromHtml(html), CHANNEL_A);
    assert.equal(resolveChannelIdFromHtml('nothing'), null);
});

test('同一動画IDの2重通知を防ぐ(ライブ終了後のアーカイブ化対応)', async () => {
    const state = {};
    const messages = [];
    let saved = 0;
    const target = { handle: 'YamakawaTeruki', channelId: CHANNEL_A, roleId: '123' };
    const args = {
        target,
        state,
        saveState: () => saved++,
        send: async (m) => messages.push(m),
        logger: { log() {} },
    };
    assert.equal(
        await sendYoutubeVideo({ ...args, video: { videoId: 'LIVE1', title: 't', kind: 'live' } }),
        true,
    );
    // 同じURL(youtu.be/LIVE1)がアーカイブとして再度来ても送らない
    assert.equal(
        await sendYoutubeVideo({ ...args, video: { videoId: 'LIVE1', title: 't', kind: 'video' } }),
        false,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^<@&123> /);
    assert.match(messages[0], /https:\/\/youtu\.be\/LIVE1/);
    assert.doesNotMatch(messages[0], /youtube\.com\/watch/);
    assert.equal(saved, 1);
});

test('通知文は種別で変わりURLはyoutu.beのみ', () => {
    const target = { handle: 'H', channelId: CHANNEL_A, roleId: null };
    assert.match(
        formatYoutubeMessage(target, { videoId: 'a', title: 't', kind: 'live' }),
        /ライブ配信を開始しました/,
    );
    assert.match(
        formatYoutubeMessage(target, { videoId: 'a', title: 't', kind: 'upcoming' }),
        /ライブ配信を予定しています/,
    );
    assert.match(
        formatYoutubeMessage(target, { videoId: 'a', title: 't', kind: 'video' }),
        /新しい動画を投稿しました/,
    );
});

test('RSS初回は通知せず基準保存、差分のみ通知する', async () => {
    const state = {};
    const messages = [];
    const target = { handle: 'H', channelId: CHANNEL_A };
    const base = { target, state, saveState: () => {}, send: async (m) => messages.push(m), logger: { log() {}, warn() {}, error() {} } };
    await checkYoutubeTarget({
        ...base,
        fetchImpl: stubFetch({
            [feedUrl(CHANNEL_A)]: sampleFeed(CHANNEL_A, [
                { id: 'V1', title: 'v1', published: '2026-10-09T00:00:00+00:00' },
            ]),
        }),
    });
    assert.equal(messages.length, 0);
    assert.equal(state.lastYoutubeVideoIds[CHANNEL_A], 'V1');
    await checkYoutubeTarget({
        ...base,
        fetchImpl: stubFetch({
            [feedUrl(CHANNEL_A)]: sampleFeed(CHANNEL_A, [
                { id: 'V1', title: 'v1', published: '2026-10-09T00:00:00+00:00' },
                { id: 'V2', title: 'v2', published: '2026-10-10T00:00:00+00:00' },
            ]),
        }),
        apiKey: 'key',
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /youtu\.be\/V2/);
});

test('Data APIを一次取得に使い、失敗時はRSSにフォールバックする', async () => {
    assert.equal(uploadsPlaylistId(CHANNEL_A), CHANNEL_A.replace(/^UC/, 'UU'));
    const playlistId = uploadsPlaylistId(CHANNEL_A);
    const apiVideos = [{ id: 'A1', title: 'api動画', published: '2026-10-10T00:00:00+00:00' }];
    const fetched = await fetchLatestVideos({
        channelId: CHANNEL_A,
        apiKey: 'key',
        fetchImpl: stubFetch({}, {}, { [playlistId]: apiVideos }),
    });
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].videoId, 'A1');
    assert.equal(fetched[0].channelId, CHANNEL_A);
    // API成功時はRSSに触れず基準保存する(RSS側は未登録=404)
    {
        const state = {};
        const messages = [];
        const calls = [];
        const counting = async (url, options) => {
            calls.push(String(url));
            return stubFetch({}, {}, { [playlistId]: apiVideos })(url, options);
        };
        await checkYoutubeTarget({
            target: { handle: 'H', channelId: CHANNEL_A },
            state,
            saveState: () => {},
            send: async (m) => messages.push(m),
            fetchImpl: counting,
            apiKey: 'key',
            logger: { log() {}, warn() {}, error() {} },
        });
        assert.equal(state.lastYoutubeVideoIds[CHANNEL_A], 'A1');
        assert.equal(messages.length, 0);
        assert.ok(calls.some((u) => u.includes('playlistItems')));
        assert.ok(!calls.some((u) => u.includes('feeds/videos.xml')));
    }
    // API失敗時はRSSにフォールバックする
    {
        const state = {};
        const messages = [];
        const xml = sampleFeed(CHANNEL_A, [
            { id: 'R1', title: 'rss動画', published: '2026-10-10T00:00:00+00:00' },
        ]);
        await checkYoutubeTarget({
            target: { handle: 'H', channelId: CHANNEL_A },
            state,
            saveState: () => {},
            send: async (m) => messages.push(m),
            fetchImpl: stubFetch({ [feedUrl(CHANNEL_A)]: xml }, {}, {}),
            apiKey: 'key',
            logger: { log() {}, warn() {}, error() {} },
        });
        assert.equal(state.lastYoutubeVideoIds[CHANNEL_A], 'R1');
        assert.equal(messages.length, 0);
    }
});

test('Data API補強でライブ状態を判定する', async () => {
    const fetchImpl = stubFetch({}, { L1: { title: 'live!', broadcast: 'live' } });
    const [video] = await enrichVideos([{ videoId: 'L1', title: 'old', kind: 'video' }], {
        apiKey: 'key',
        fetchImpl,
    });
    assert.equal(video.kind, 'live');
    assert.equal(video.title, 'live!');
    const same = await enrichVideos([{ videoId: 'L1', title: 'old', kind: 'video' }], {});
    assert.equal(same[0].kind, 'video');
});

test('WebSub検証応答とPush通知・重複除外', async (t) => {
    const state = {};
    const messages = [];
    let saved = 0;
    const server = createWebsubServer({
        targets: [{ handle: 'H', channelId: CHANNEL_A }],
        state,
        saveState: () => saved++,
        send: async (m) => messages.push(m),
        logger: { log() {}, error() {} },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/youtube/websub/${CHANNEL_A}`;
    const good = await fetch(
        `${base}?hub.mode=subscribe&hub.topic=${encodeURIComponent(feedUrl(CHANNEL_A))}&hub.challenge=abc123`,
    );
    assert.equal(good.status, 200);
    assert.equal(await good.text(), 'abc123');
    const badTopic = await fetch(`${base}?hub.mode=subscribe&hub.topic=https://evil.example/&hub.challenge=x`);
    assert.equal(badTopic.status, 404);
    const xml = sampleFeed(CHANNEL_A, [
        { id: 'W1', title: 'w1', published: '2026-10-10T00:00:00+00:00' },
    ]);
    // 初回は基準保存のみ
    assert.equal((await fetch(base, { method: 'POST', body: xml })).status, 204);
    assert.equal(messages.length, 0);
    const xml2 = sampleFeed(CHANNEL_A, [
        { id: 'W1', title: 'w1', published: '2026-10-10T00:00:00+00:00' },
        { id: 'W2', title: 'w2', published: '2026-10-10T01:00:00+00:00' },
    ]);
    assert.equal((await fetch(base, { method: 'POST', body: xml2 })).status, 204);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /youtu\.be\/W2/);
    // 同じ内容の再送は無視
    assert.equal((await fetch(base, { method: 'POST', body: xml2 })).status, 204);
    assert.equal(messages.length, 1);
    assert.ok(saved >= 2);
});

test('署名検証とコールバックURL生成', () => {
    const crypto = require('node:crypto');
    assert.equal(
        callbackUrlFor('https://example.com/', CHANNEL_A),
        `https://example.com/youtube/websub/${CHANNEL_A}`,
    );
    const secret = 's3cret';
    const body = Buffer.from('hello');
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    assert.equal(signatureValid(secret, sig, body), true);
    assert.equal(signatureValid(secret, 'sha256=deadbeef', body), false);
    assert.equal(signatureValid(undefined, undefined, body), true);
});

test('YOUTUBE_UPDATESの選別とstate初期値', (t) => {
    assert.deepEqual(youtubeTargets({}), []);
    assert.deepEqual(youtubeTargets({ YOUTUBE_UPDATES: { handle: 'H', channelId: CHANNEL_A } }), [
        { handle: 'H', channelId: CHANNEL_A },
    ]);
    assert.deepEqual(
        youtubeTargets({ YOUTUBE_UPDATES: [null, { enabled: false }, { handle: 'H' }] }),
        [{ handle: 'H' }],
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-yt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{}');
    const store = createStateStore(file, [], { log() {} });
    assert.deepEqual(store.state.youtubeSeenVideoIds, []);
    assert.deepEqual(store.state.lastYoutubeVideoIds, {});
});
