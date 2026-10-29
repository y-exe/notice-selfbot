const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../src/discord/notifications');
const { checkYoutubeTarget } = require('../src/youtube/rss');
const { createWebsubServer } = require('../src/youtube/websub');

const logger = { log() {}, warn() {}, error() {} };
const target = {
    channelId: 'UCtest',
    roleId: 'clip-role',
    notificationChannelId: 'clip-destination',
    videosOnly: true,
};
const initialState = () => ({
    lastYoutubeVideoIds: { UCtest: 'old' },
    youtubeSeenVideoIds: ['old'],
});

function apiFetch(videos, details, options = {}) {
    return async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/playlistItems'))
            return {
                ok: true,
                json: async () => ({
                    items: videos.map((videoId, i) => ({
                        contentDetails: {
                            videoId,
                            videoPublishedAt: new Date(i * 1000).toISOString(),
                        },
                        snippet: { title: videoId },
                    })),
                }),
            };
        assert.equal(
            parsed.searchParams.get('part'),
            'snippet,liveStreamingDetails',
        );
        if (options.fail) return { ok: false, status: 503 };
        return { ok: true, json: async () => ({ items: details }) };
    };
}

test('通常動画だけを指定ロール・指定チャンネルに通知し、ライブとアーカイブは除外する', async () => {
    const messages = [];
    const state = initialState();
    const details = [
        {
            id: 'normal',
            snippet: { title: '通常動画', liveBroadcastContent: 'none' },
        },
        {
            id: 'live',
            snippet: { liveBroadcastContent: 'live' },
            liveStreamingDetails: { actualStartTime: '2026-10-01T00:00:00Z' },
        },
        { id: 'upcoming', snippet: { liveBroadcastContent: 'upcoming' } },
        {
            id: 'archive',
            snippet: { liveBroadcastContent: 'none' },
            liveStreamingDetails: { actualEndTime: '2026-10-01T01:00:00Z' },
        },
    ];
    const args = {
        target,
        state,
        saveState() {},
        send: async (message, destination) =>
            messages.push({ message, destination }),
        apiKey: 'test-key',
        logger,
        fetchImpl: apiFetch(
            ['normal', 'live', 'upcoming', 'archive', 'unavailable'],
            details,
        ),
    };
    await checkYoutubeTarget(args);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].destination, 'clip-destination');
    assert.match(messages[0].message, /^<@&clip-role>/);
    assert.match(messages[0].message, /通常動画/);
    assert.ok(state.youtubeSeenVideoIds.includes('archive'));
    assert.ok(
        !state.youtubeSeenVideoIds.includes('unavailable'),
        '判定不可は保留',
    );
    await checkYoutubeTarget(args);
    assert.equal(messages.length, 1);
});

test('動画限定の対象は詳細APIの失敗時に誤通知せず、回復したら再判定する', async () => {
    const state = initialState();
    let sent = 0;
    const args = {
        target,
        state,
        saveState() {},
        send: async () => sent++,
        apiKey: 'test-key',
        logger,
    };
    const details = [{ id: 'new', snippet: { liveBroadcastContent: 'none' } }];
    await checkYoutubeTarget({
        ...args,
        fetchImpl: apiFetch(['new'], details, { fail: true }),
    });
    assert.equal(sent, 0);
    assert.ok(!state.youtubeSeenVideoIds.includes('new'));
    await checkYoutubeTarget({
        ...args,
        fetchImpl: apiFetch(['new'], details),
    });
    assert.equal(sent, 1);
});

test('APIキーなしでは動画限定の対象を通知しない', async () => {
    const state = initialState();
    await checkYoutubeTarget({
        target,
        state,
        saveState() {},
        logger,
        send: async () => assert.fail('種別未確認では送信しない'),
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () =>
                '<feed><entry><yt:videoId>new</yt:videoId></entry></feed>',
        }),
    });
    assert.ok(!state.youtubeSeenVideoIds.includes('new'));
});

test('通知先の上書きはその送信だけに適用し、従来の送信先は維持する', async () => {
    const destinations = [];
    const notifier = createNotifier(
        {
            channels: {
                fetch: async (id) => {
                    destinations.push(id);
                    return { send: async () => {} };
                },
            },
        },
        'existing-destination',
    );
    await notifier('既存');
    await notifier('追加', 'clip-destination');
    await notifier('既存');
    assert.deepEqual(destinations, [
        'existing-destination',
        'clip-destination',
        'existing-destination',
    ]);
});

test('空のチャンネルも基準更新し、最初の新規動画を通知する', async () => {
    const state = {};
    let sent = 0;
    const args = {
        target,
        state,
        saveState() {},
        logger,
        apiKey: 'test-key',
        send: async () => sent++,
    };
    await checkYoutubeTarget({
        ...args,
        baselineOnly: true,
        fetchImpl: apiFetch([], []),
    });
    await checkYoutubeTarget({
        ...args,
        fetchImpl: apiFetch(
            ['first'],
            [{ id: 'first', snippet: { liveBroadcastContent: 'none' } }],
        ),
    });
    assert.equal(sent, 1);
});

test('WebSub経由でも配信アーカイブを除外し、通常動画だけを別チャンネルへ送る', async (t) => {
    const messages = [];
    const server = createWebsubServer({
        targets: [target],
        state: initialState(),
        saveState() {},
        logger,
        notificationSince: 0,
        apiKey: 'test-key',
        send: async (message, destination) =>
            messages.push({ message, destination }),
        fetchImpl: apiFetch(
            [],
            [
                {
                    id: 'archive',
                    snippet: { liveBroadcastContent: 'none' },
                    liveStreamingDetails: {
                        actualEndTime: '2026-10-01T01:00:00Z',
                    },
                },
                { id: 'normal', snippet: { liveBroadcastContent: 'none' } },
            ],
        ),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const body =
        '<feed>' +
        ['archive', 'normal']
            .map(
                (id) =>
                    `<entry><yt:videoId>${id}</yt:videoId><published>2026-10-30T00:00:00Z</published></entry>`,
            )
            .join('') +
        '</feed>';
    const response = await fetch(
        `http://127.0.0.1:${server.address().port}/youtube/websub/UCtest`,
        { method: 'POST', body },
    );
    assert.equal(response.status, 204);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].destination, 'clip-destination');
});
