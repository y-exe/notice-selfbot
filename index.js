const { Client } = require('discord.js-selfbot-v13');
const OBSWebSocket = require('obs-websocket-js').default;
const RssParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const config = require('./config.json');
const client = new Client({ checkUpdate: false });
const parser = new RssParser();
const obs = new OBSWebSocket();

const STATE_FILE_PATH = path.join(__dirname, 'state.json');
let state = { lastTweetGuid: null };
let notificationCooldowns = {};
let isStreaming = false;
let activeOBSSourceInfo = null;
let streamStartTime = null;
let leaveTimers = {};

// --- OBS連携 ---
async function connectToOBS() {
    if (!config.OBS_WEBSOCKET.enabled) {
        console.log('OBS WebSocket integration is disabled in config.json.');
        return;
    }
    try {
        obs.on('StreamStateChanged', data => {
            isStreaming = data.outputActive;
            console.log(`OBS Stream State Changed: ${isStreaming ? 'STREAMING' : 'STOPPED'}`);
            // 配信が停止されたら、アクティブソースと開始時刻もリセット
            if (!isStreaming) {
                activeOBSSourceInfo = null;
                streamStartTime = null;
            }
        });

        await obs.connect(config.OBS_WEBSOCKET.address, process.env.OBS_PASSWORD);
        console.log('Successfully connected to OBS WebSocket.');

        const { outputActive } = await obs.call('GetStreamStatus');
        isStreaming = outputActive;
        console.log(`Initial OBS stream state: ${isStreaming ? 'STREAMING' : 'OFFLINE'}`);

    } catch (error) {
        console.error('Failed to connect to OBS WebSocket. Ensure OBS is running and WebSocket server is enabled.', error.code || error.message);
    }
}

// --- OBS ソース制御関数 ---
async function setOBSSourceVisibility(sceneName, sourceName, visible) {
    if (!config.OBS_WEBSOCKET.enabled) return;
    try {
        const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName });
        await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: visible });
        console.log(`Source '${sourceName}' in scene '${sceneName}' set to ${visible ? 'VISIBLE' : 'HIDDEN'}.`);
    } catch (error) {
        console.error(`Failed to set visibility for source '${sourceName}':`, error.message);
    }
}

// --- 状態管理 ---
function loadState() {
    if (fs.existsSync(STATE_FILE_PATH)) {
        try {
            state = JSON.parse(fs.readFileSync(STATE_FILE_PATH));
            console.log('State loaded successfully.');
        } catch (e) {
            console.error('Failed to parse state file.', e);
        }
    } else {
        console.log('No state file found, starting fresh.');
    }
}
function saveState() {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

// --- 通知送信 ---
async function sendNotification(message) {
    try {
        const channel = await client.channels.fetch(config.NOTIFICATION_CHANNEL_ID);
        await channel.send(message);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
}

// --- Twitter (rss.app) 監視 ---
async function checkTwitter() {
    if (!config.TWITTER_UPDATES.enabled) return;
    const { rssAppUrl, roleId } = config.TWITTER_UPDATES;
    try {
        const feed = await parser.parseURL(rssAppUrl);
        const twitterItems = feed.items.filter(item =>
            item.link && item.title &&
            (item.link.includes('x.com') || item.link.includes('twitter.com')) &&
            !item.title.startsWith('@') && !item.title.startsWith('RT by')
        );

        if (!twitterItems.length) return;
        const latestTweet = twitterItems[0];

        if (state.lastTweetGuid !== latestTweet.guid) {
            if (state.lastTweetGuid !== null) {
                console.log(`New tweet found: ${latestTweet.link}`);
                await sendNotification(`<@&${roleId}> **YamakawaTeruki**さんが新しいツイートを投稿しました！\n${latestTweet.link}`);
            }
            state.lastTweetGuid = latestTweet.guid;
            saveState();
        }
    } catch (error) {
        console.error(`Failed to fetch Twitter feed:`, error.message);
    }
}

// --- 配信時間監視タイマー ---
function startStreamDurationMonitor() {
    console.log('Stream duration monitor started.');
    setInterval(async () => {
        if (isStreaming && streamStartTime) {
            const elapsedTime = Date.now() - streamStartTime;
            const durationLimit = 11.5 * 60 * 60 * 1000; // 11時間30分

            if (elapsedTime >= durationLimit) {
                console.log(`Stream duration limit (11.5 hours) reached. Stopping stream...`);
                try {
                    await obs.call('StopStream');
                    streamStartTime = null; // タイマーをリセット
                    await sendNotification('配信開始から11時間30分が経過したため、自動的に配信を終了しました。');
                } catch (error) {
                    console.error('Failed to auto-stop stream:', error.message);
                }
            }
        }
    }, 60 * 1000); // 1分ごとにチェック
}

// --- Discordイベントハンドラ ---
client.on('ready', async () => {
    console.log(`Notifier Bot logged in as ${client.user.tag}`);
    loadState();
    await connectToOBS();
    if (config.OBS_WEBSOCKET.enabled) {
        startStreamDurationMonitor();
    }
    if (config.TWITTER_UPDATES.enabled) {
        console.log('Starting Twitter monitoring...');
        checkTwitter();
        setInterval(checkTwitter, config.CHECK_INTERVAL_SECONDS * 1000);
    }
});

client.on('guildScheduledEventCreate', async (event) => {
    if (!config.EVENT_CREATION.enabled || event.guildId !== config.EVENT_CREATION.serverId) return;
    console.log(`New event created: ${event.name}`);
    const message = `<@&${config.EVENT_CREATION.roleId}>\n**イベントが追加**されました\nhttps://discord.com/events/${event.guildId}/${event.id}`;
    await sendNotification(message);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    // --- 入室処理 ---
    const joinConfig = config.VOICE_STATE_UPDATES.find(c => c.enabled && c.userId === newState.id && c.channelId === newState.channelId && c.serverId === newState.guild.id && oldState.channelId !== newState.channelId);
    if (joinConfig) {
        if (leaveTimers[joinConfig.channelId]) {
            console.log(`Re-join detected for ${joinConfig.type}. Canceling stream stop timer.`);
            clearTimeout(leaveTimers[joinConfig.channelId]);
            delete leaveTimers[joinConfig.channelId];
            return;
        }
        const now = Date.now();
        if (now - (notificationCooldowns[joinConfig.channelId] || 0) < 180000) {
            console.log(`Duplicate notification for ${joinConfig.type} detected. Ignoring.`);
            return;
        }
        console.log(`User ${newState.member.displayName} joined ${joinConfig.type}. Notifying and processing OBS...`);
        notificationCooldowns[joinConfig.channelId] = now;
        const message = `<@&${joinConfig.roleId}>\nhttps://discord.com/channels/${joinConfig.serverId}/${joinConfig.channelId}\nにて**${joinConfig.type}**が始まりました!!`;
        await sendNotification(message);
        if (config.OBS_WEBSOCKET.enabled) {
            const { sceneName, sourceName } = joinConfig.obsSettings;
            try {
                if (activeOBSSourceInfo && activeOBSSourceInfo.sourceName !== sourceName) {
                    await setOBSSourceVisibility(activeOBSSourceInfo.sceneName, activeOBSSourceInfo.sourceName, false);
                }
                await obs.call('SetCurrentProgramScene', { sceneName });
                await setOBSSourceVisibility(sceneName, sourceName, true);
                activeOBSSourceInfo = { sceneName, sourceName };
                if (!isStreaming) {
                    await obs.call('StartStream');
                    console.log('OBS stream start command sent.');
                    streamStartTime = Date.now();
                }
            } catch (error) {
                console.error('Failed to control OBS on join:', error.message);
            }
        }
        return;
    }

    // --- 退出処理 ---
    const leaveConfig = config.VOICE_STATE_UPDATES.find(c => c.enabled && c.userId === oldState.id && c.channelId === oldState.channelId && c.serverId === oldState.guild.id);
    if (leaveConfig) {
        const vc = await client.channels.fetch(leaveConfig.channelId);
        const targetUsersInVC = vc.members.filter(member => member.id === leaveConfig.userId);
        if (targetUsersInVC.size === 0 && isStreaming) {
            console.log(`Target user left ${leaveConfig.type}. Starting 3-minute grace period before stopping stream...`);
            if (leaveTimers[leaveConfig.channelId]) {
                clearTimeout(leaveTimers[leaveConfig.channelId]);
            }
            leaveTimers[leaveConfig.channelId] = setTimeout(async () => {
                console.log(`Grace period ended for ${leaveConfig.type}. User did not rejoin. Stopping stream...`);
                if (config.OBS_WEBSOCKET.enabled) {
                    try {
                        const { sceneName, sourceName } = leaveConfig.obsSettings;
                        await setOBSSourceVisibility(sceneName, sourceName, false);
                        activeOBSSourceInfo = null;
                        if (isStreaming) {
                            await obs.call('StopStream');
                            console.log('OBS stream stop command sent.');
                        }
                    } catch (error) {
                        console.error('Failed to control OBS on leave:', error.message);
                    }
                }
                delete leaveTimers[leaveConfig.channelId];
            }, 180000); // 3分
        }
    }
});

// --- 実行 ---
client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("Fatal Login Error:", err.message);
});
