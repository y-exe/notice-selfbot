const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('移行先Clientの基本APIとワーカーの正常終了を確認する', () => {
    const result = spawnSync(process.execPath, ['-e', `
        const { Client } = require('discord.js-selfbot-youtsuho-v13');
        const client = new Client({ checkUpdate: false });
        for (const method of ['login', 'destroy', 'isReady']) {
            if (typeof client[method] !== 'function') throw new Error(method);
        }
        if (typeof client.channels.fetch !== 'function') throw new Error('channels.fetch');
        setTimeout(() => client.destroy(), 200);
    `], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', '終了時にエラーを出さない');
});
