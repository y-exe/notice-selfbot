const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkYoutubeTarget } = require('../src/youtube/rss');

test('新着の詳細APIが失敗しても一覧の情報で通知し、次回は重複送信しない', async () => {
    const state = {
        lastYoutubeVideoIds: { UCexample: 'old' },
        youtubeSeenVideoIds: ['old'],
    };
    const messages = [];
    let saves = 0;
    const run = () =>
        checkYoutubeTarget({
            target: { channelId: 'UCexample', handle: 'example' },
            state,
            apiKey: 'test-key',
            saveState: () => saves++,
            send: async (message) => messages.push(message),
            logger: { log() {}, warn() {}, error() {} },
            fetchImpl: async (url) => {
                if (new URL(url).pathname.endsWith('/playlistItems'))
                    return {
                        ok: true,
                        json: async () => ({
                            items: [
                                {
                                    contentDetails: {
                                        videoId: 'new',
                                        videoPublishedAt:
                                            '2026-10-20T00:00:00Z',
                                    },
                                    snippet: { title: '新着動画' },
                                },
                            ],
                        }),
                    };
                return { ok: false, status: 503 };
            },
        });
    await run();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /新着動画/);
    assert.match(messages[0], /https:\/\/youtu\.be\/new/);
    assert.ok(state.youtubeSeenVideoIds.includes('new'));
    assert.equal(state.lastYoutubeVideoIds.UCexample, 'new');
    assert.equal(saves, 1);
    await run();
    assert.equal(messages.length, 1);
});

test('詳細APIが失敗してもDiscord送信失敗の動画を既読にしない', async () => {
    const state = {
        lastYoutubeVideoIds: { UCexample: 'old' },
        youtubeSeenVideoIds: ['old'],
    };
    await checkYoutubeTarget({
        target: { channelId: 'UCexample' },
        state,
        apiKey: 'test-key',
        saveState: () => {},
        send: async () => {
            throw new Error('Discord unavailable');
        },
        logger: { warn() {}, error() {} },
        fetchImpl: async (url) =>
            new URL(url).pathname.endsWith('/playlistItems')
                ? {
                      ok: true,
                      json: async () => ({
                          items: [
                              {
                                  contentDetails: { videoId: 'new' },
                                  snippet: { title: '新着' },
                              },
                          ],
                      }),
                  }
                : { ok: false, status: 400 },
    });
    assert.deepEqual(state.youtubeSeenVideoIds, ['old']);
    assert.equal(state.lastYoutubeVideoIds.UCexample, 'old');
});
