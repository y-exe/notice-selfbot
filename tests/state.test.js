const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../src/storage/state');
const { twitterTargets } = require('../src/config');

test('既存の投稿IDと重複履歴を再起動後も保持する', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-state-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(
        file,
        JSON.stringify({
            lastTweetGuid: '123',
            lastTweetGuids: { Existing: '122' },
            twitterPushSeenIds: ['121'],
        }),
    );
    const logger = { log() {} };
    const store = createStateStore(file, [{ username: 'Target' }], logger);
    assert.equal(store.state.lastTweetGuids.Target, '123');
    assert.equal(store.state.lastTweetGuids.Existing, '122');
    store.state.twitterPushSeenIds.push('124');
    store.save();
    assert.deepEqual(
        createStateStore(file, [], logger).state.twitterPushSeenIds,
        ['121', '124'],
    );
    fs.writeFileSync(file, '{');
    assert.throws(() => createStateStore(file, [], logger));
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('単一対象と配列の設定を扱い、無効な対象を除外する', () => {
    assert.deepEqual(twitterTargets({}), []);
    assert.deepEqual(twitterTargets({ TWITTER_UPDATES: { username: 'one' } }), [
        { username: 'one' },
    ]);
    assert.deepEqual(
        twitterTargets({
            TWITTER_UPDATES: [null, { enabled: false }, { username: 'two' }],
        }),
        [{ username: 'two' }],
    );
});
