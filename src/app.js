const path = require('node:path');
const { Client } = require('discord.js-selfbot-v13');
const { root, loadConfig, twitterTargets } = require('./config');
const { createStateStore } = require('./storage/state');
const { createNotifier } = require('./discord/notifications');
const { createEventHandler } = require('./discord/events');
const { createVoiceHandler } = require('./discord/voice');
const { startHeartbeat } = require('./monitoring/heartbeat');
const { createPushServer } = require('./twitter/push');
const { startGraphqlMonitor } = require('./twitter/graphql');

async function start() {
    const config = loadConfig();
    const targets = twitterTargets(config);
    const store = createStateStore(path.join(root, 'state.json'), targets);
    const client = new Client({ checkUpdate: false });
    const send = createNotifier(client, config.NOTIFICATION_CHANNEL_ID);
    let server;
    let stopHeartbeat = () => {};
    let stopTwitter = () => {};
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        stopHeartbeat();
        stopTwitter();
        if (server) {
            server.close();
            server.closeAllConnections();
        }
        client.destroy();
    };
    const handle =
        (handler) =>
        (...args) => {
            Promise.resolve()
                .then(() => handler(...args))
                .catch((error) =>
                    console.error('Discord通知に失敗しました:', error.message),
                );
        };
    client.on(
        'guildScheduledEventCreate',
        handle(createEventHandler(config, send)),
    );
    client.on('voiceStateUpdate', handle(createVoiceHandler(config, send)));
    client.once('ready', () => {
        if (stopping) return;
        console.log(`Discordにログインしました: ${client.user.tag}`);
        stopHeartbeat = startHeartbeat(process.env.WATCHER_PUSH_URL);
        if (!targets.length) return;
        const source =
            process.env.TWITTER_SOURCE ||
            config.TWITTER_SOURCE ||
            'angelic-angel';
        if (source === 'graphql') {
            stopTwitter = startGraphqlMonitor({
                config,
                state: store.state,
                saveState: store.save,
                sendNotification: send,
            });
        } else if (source === 'angelic-angel') {
            server = createPushServer({
                targets,
                state: store.state,
                saveState: store.save,
                send,
                isReady: () => client.isReady(),
            });
            server.on('error', (error) => {
                console.error(
                    'X通知の受信サーバーを起動できませんでした:',
                    error.message,
                );
                process.exitCode = 1;
                stop();
            });
            server.listen(
                Number(process.env.TWITTER_PUSH_PORT || 8787),
                process.env.TWITTER_PUSH_HOST || '127.0.0.1',
                () =>
                    console.log('Angelic-AngelからのX通知を受信待機しています'),
            );
        } else {
            console.error(`未対応のX取得方式です: ${source}`);
            process.exitCode = 1;
            stop();
        }
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
    try {
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        stop();
        throw error;
    }
}
module.exports = { start };
