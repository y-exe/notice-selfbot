const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEventHandler } = require('../src/discord/events');
const { createVoiceHandler } = require('../src/discord/voice');
const { createNotifier } = require('../src/discord/notifications');

test('指定サーバーのイベントだけを通知する', async () => {
    const messages = [];
    const handler = createEventHandler(
        {
            EVENT_CREATION: {
                enabled: true,
                serverId: 'guild',
                roleId: 'role',
            },
        },
        async (message) => messages.push(message),
    );
    await handler({ guildId: 'other', id: '1' });
    await handler({ guildId: 'guild', id: '2' });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^<@&role>/);
    assert.ok(messages[0].endsWith('/guild/2'));
});

test('VC通知は入室時だけ送信し、再入室のクールダウンを守る', async () => {
    const messages = [];
    let timestamp = 0;
    const config = {
        VOICE_STATE_UPDATES: [
            {
                enabled: true,
                serverId: 'guild',
                channelId: 'vc',
                userId: 'user',
                type: '作業配信',
            },
        ],
    };
    const handler = createVoiceHandler(
        config,
        async (message) => messages.push(message),
        () => timestamp,
    );
    const current = { id: 'user', channelId: 'vc', guild: { id: 'guild' } };
    await handler({ channelId: 'vc' }, current);
    await handler({ channelId: null }, { ...current, id: 'other' });
    await handler({ channelId: null }, current);
    timestamp = 179999;
    await handler({ channelId: null }, current);
    timestamp = 180000;
    await handler({ channelId: null }, current);
    assert.equal(messages.length, 2);
    assert.ok(!messages[0].includes('undefined'));
});

test('送信失敗でVCのクールダウンや通知成功を記録しない', async () => {
    let fail = true;
    let sent = 0;
    const send = createNotifier(
        {
            channels: {
                fetch: async () => ({
                    send: async () => {
                        if (fail) throw new Error('送信失敗');
                        sent++;
                    },
                }),
            },
        },
        'channel',
    );
    const config = {
        VOICE_STATE_UPDATES: [
            {
                enabled: true,
                serverId: 'guild',
                channelId: 'vc',
                userId: 'user',
            },
        ],
    };
    const handler = createVoiceHandler(config, send, () => 0);
    const current = { id: 'user', channelId: 'vc', guild: { id: 'guild' } };
    await assert.rejects(handler({ channelId: null }, current), /送信失敗/);
    fail = false;
    await handler({ channelId: null }, current);
    assert.equal(sent, 1);
});
