const { Client } = require('discord.js-selfbot-v13');
const OBSWebSocket = require('obs-websocket-js').default;
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const config = require('./config.json');
const client = new Client({ checkUpdate: false });
const obs = new OBSWebSocket();

const STATE_FILE_PATH = path.join(__dirname, 'state.json');
let state = { lastTweetId: null };
let notificationCooldowns = {};
let isStreaming = false;
let activeOBSSourceInfo = null;
let streamStartTime = null;
let leaveTimers = {};

async function connectToOBS() {
    if (!config.OBS_WEBSOCKET.enabled) {
        console.log('OBS WebSocket integration is disabled in config.json.');
        return;
    }
    try {
        obs.on('StreamStateChanged', data => {
            isStreaming = data.outputActive;
            console.log(`OBS Stream State Changed: ${isStreaming ? 'STREAMING' : 'STOPPED'}`);
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

async function sendNotification(message) {
    try {
        const channel = await client.channels.fetch(config.NOTIFICATION_CHANNEL_ID);
        await channel.send(message);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
}

async function checkTwitter() {
    if (!config.TWITTER_UPDATES.enabled) return;
    const { nitterUsername, roleId } = config.TWITTER_UPDATES;
    const nitterUrl = `https://nitter.net/${nitterUsername}`;

    try {
        const response = await axios.get(nitterUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(response.data);

        let latestTweetId = null;
        let latestTweetLink = null;

        $('.timeline-item').each((i, el) => {
            const element = $(el);
            if (!element.find('.retweet-header').length && !element.find('.replying-to').length) {
                const linkElement = element.find('a[href*="/status/"]');
                const relativeLink = linkElement.attr('href');
                
                if (relativeLink) {
                    const statusId = relativeLink.split('/status/')[1].split('#')[0];
                    latestTweetId = statusId;
                    latestTweetLink = `https://x.com${relativeLink.split('#')[0]}`;
                    return false; // ループを抜ける
                }
            }
        });

        if (latestTweetId && state.lastTweetId !== latestTweetId) {
            if (state.lastTweetId !== null) {
                console.log(`New tweet found: ${latestTweetLink}`);
                await sendNotification(`<@&${roleId}> **${nitterUsername}**さんが新しいツイートを投稿しました！\n${latestTweetLink}`);
            }
            state.lastTweetId = latestTweetId;
            saveState();
        }

    } catch (error) {
        console.error(`Failed to scrape Nitter for ${nitterUsername}:`, error.message);
    }
}

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
                    streamStartTime = null;
                    await sendNotification('配信開始から11時間30分が経過したため、自動的に配信を終了しました。');
                } catch (error) {
                    console.error('Failed to auto-stop stream:', error.message);
                }
            }
        }
    }, 60 * 1000); 
}

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

    const leaveConfig = config.VOICE_STATE_UPDATES.find(c => c.enabled && c.userId === oldState.id && c.channelId === oldState.channelId && c.serverId === oldState.guild.id);
    if (leaveConfig) {
        try {
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
                }, 180000); 
            }
        } catch (error) {
            console.error('An error occurred during leave processing (fetching VC):', error);
        }
    }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("Fatal Login Error:", err.message);
});
