const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, twitterTargets, youtubeTargets } = require('../src/config');

test('外部設定を読み込み、未配置や不正な形式では起動しない', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.json');
    assert.throws(() => loadConfig(file), /設定ファイルがありません/);
    fs.writeFileSync(file, JSON.stringify({ NOTIFICATION_CHANNEL_ID: 'test-channel' }));
    assert.equal(loadConfig(file).NOTIFICATION_CHANNEL_ID, 'test-channel');
    fs.writeFileSync(file, '[]');
    assert.throws(() => loadConfig(file), /JSONオブジェクト/);
    fs.writeFileSync(file, '{');
    assert.throws(() => loadConfig(file), SyntaxError);
});

test('サンプル設定は実IDを含まず、監視対象が無効になっている', () => {
    const example = loadConfig(path.join(__dirname, '..', 'config.example.json'));
    assert.equal(example.NOTIFICATION_CHANNEL_ID, '');
    assert.deepEqual(twitterTargets(example), []);
    assert.deepEqual(youtubeTargets(example), []);
    assert.equal(example.EVENT_CREATION.enabled, false);
    assert.ok(example.VOICE_STATE_UPDATES.every(target => !target.enabled));
    assert.ok(!/\d{15,}/.test(JSON.stringify(example)));
});
