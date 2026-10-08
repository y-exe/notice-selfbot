const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPushServer, parseTweet } = require('../src/twitter/push');

test('parse nested post URLs and reject unrelated or ambiguous notifications', () => {
    assert.deepEqual(
        parseTweet({ data: { url: 'https://x.com/Example/status/123?s=20' } }),
        { username: 'Example', id: '123' },
    );
    assert.deepEqual(parseTweet({ uri: '/Example/status/124' }), {
        username: 'Example',
        id: '124',
    });
    for (const url of [
        'https://evil.com/Example/status/123',
        '/i/web/status/123',
        'https://x.com/home',
    ]) {
        assert.equal(parseTweet({ url }), null);
    }
});

test('webhook filters targets, serializes duplicates, keeps out-of-order posts, and retries failed sends', async (t) => {
    const state = { lastTweetGuids: {} };
    const messages = [];
    let ready = true;
    let fail = false;
    let saved = 0;
    const server = createPushServer({
        targets: [
            { username: 'Example', roleId: '123' },
            { username: 'Disabled', enabled: false },
        ],
        state,
        saveState: () => saved++,
        isReady: () => ready,
        send: async (message) => {
            if (fail) throw new Error('unavailable');
            messages.push(message);
        },
        logger: { warn() {}, error() {} },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const endpoint = `http://127.0.0.1:${server.address().port}/twitter/push`;
    const post = (body) =>
        fetch(endpoint, {
            method: 'POST',
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
    const payload = (id) => ({
        title: '新しい投稿',
        data: { url: `https://x.com/example/status/${id}` },
    });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('x'.repeat(65537))).status, 413);
    ready = false;
    assert.equal((await post(payload('100'))).status, 503);
    ready = true;
    const duplicates = await Promise.all([
        post(payload('100')),
        post(payload('100')),
    ]);
    assert.ok(duplicates.every((r) => r.status === 204));
    assert.equal(messages.length, 1);
    await post(payload('99'));
    await post(payload('100'));
    await post({ url: 'https://x.com/Disabled/status/101' });
    await post({ url: 'https://x.com/Other/status/102' });
    assert.equal(messages.length, 2);
    assert.equal(saved, 2);
    assert.match(messages[0], /^<@&123> /);
    fail = true;
    assert.equal((await post(payload('103'))).status, 500);
    assert.ok(!state.twitterPushSeenIds.includes('103'));
    fail = false;
    assert.equal((await post(payload('103'))).status, 204);
    assert.equal(messages.length, 3);
});
