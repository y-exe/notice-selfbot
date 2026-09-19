require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
// const OBSWebSocket = require('obs-websocket-js').default;
const axios = require('axios');
const { Scraper } = require('agent-twitter-client');
const fs = require('fs');
const path = require('path');

const config = require('./config.json');
const client = new Client({ checkUpdate: false });
const scraper = new Scraper();
// const obs = new OBSWebSocket();

const STATE_FILE_PATH = path.join(__dirname, 'state.json');

const NOTIFICATION_COOLDOWN_MS = 180 * 1000; // 3分 (通知のクールダウン)
const STREAM_STOP_GRACE_PERIOD_MS = 180 * 1000; // 3分 (配信停止までの猶予時間)
const STREAM_DURATION_LIMIT_MS = 11.5 * 60 * 60 * 1000; // 11時間30分 (配信時間の上限)

let state = { lastTweetGuid: null };
let notificationCooldowns = {};
let leaveTimers = {};
let isStreaming = false;
let activeOBSSourceInfo = null;
let streamStartTime = null;
let isInitialTwitterCheck = true;
let isTwitterInitialized = false;

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

/**
 * 指定されたチャンネルに通知メッセージを送信する
 * @param {string} message - 送信するメッセージ内容
 */
async function sendNotification(message) {
    try {
        const channel = await client.channels.fetch(config.NOTIFICATION_CHANNEL_ID);
        await channel.send(message);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
}

/*
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
*/

/**
 * OBSの特定のソースの表示/非表示を切り替える
 * @param {string} sceneName - シーン名
 * @param {string} sourceName - ソース名
 * @param {boolean} visible - 表示状態
 */
/*
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
*/

/*
function startStreamDurationMonitor() {
    console.log('Stream duration monitor started.');
    setInterval(async () => {
        if (isStreaming && streamStartTime) {
            const elapsedTime = Date.now() - streamStartTime;
            if (elapsedTime >= STREAM_DURATION_LIMIT_MS) {
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
*/

async function initTwitterAuth() {
    if (process.env.TWITTER_AUTH_TOKEN && process.env.TWITTER_CT0) {
        const cookies = [
            `auth_token=${process.env.TWITTER_AUTH_TOKEN}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
            `ct0=${process.env.TWITTER_CT0}; Domain=.twitter.com; Path=/; Secure`
        ];
        if (process.env.TWITTER_TWID) {
            cookies.push(`twid=${process.env.TWITTER_TWID}; Domain=.twitter.com; Path=/; Secure`);
        }
        await scraper.setCookies(cookies);
        isTwitterInitialized = true;
        console.log('Twitter client authenticated via discrete cookies.');
        return;
    }

    if (process.env.TWITTER_COOKIES) {
        let cookies;
        try {
            cookies = JSON.parse(process.env.TWITTER_COOKIES);
        } catch {
            cookies = process.env.TWITTER_COOKIES.split(';').map(c => c.trim()).filter(Boolean);
        }
        if (Array.isArray(cookies) && cookies.length > 0) {
            await scraper.setCookies(cookies);
            isTwitterInitialized = true;
            console.log('Twitter client authenticated via TWITTER_COOKIES.');
            return;
        }
    }

    if (process.env.TWITTER_USERNAME && process.env.TWITTER_PASSWORD) {
        console.log('Logging in to Twitter with username and password...');
        await scraper.login(
            process.env.TWITTER_USERNAME,
            process.env.TWITTER_PASSWORD,
            process.env.TWITTER_EMAIL
        );
        isTwitterInitialized = true;
        console.log('Twitter client logged in successfully.');
        return;
    }

    console.warn('No Twitter credentials found. Please set TWITTER_AUTH_TOKEN & TWITTER_CT0 in environment.');
}

async function checkTwitter() {
    if (!config.TWITTER_UPDATES?.enabled) return;

    const username = config.TWITTER_UPDATES.username || config.TWITTER_UPDATES.nitterUsername || 'YamakawaTeruki';
    const roleId = config.TWITTER_UPDATES.roleId;

    try {
        if (!isTwitterInitialized) {
            await initTwitterAuth();
        }

        const tweetsGenerator = scraper.getTweets(username, 10);
        let latestNormalTweet = null;

        for await (const tweet of tweetsGenerator) {
            if (!tweet || !tweet.id) continue;
            // リツイートやリプライは除外
            if (tweet.isRetweet || tweet.isReply) continue;

            latestNormalTweet = tweet;
            break;
        }

        if (!latestNormalTweet) {
            console.warn(`No valid tweet found for ${username}`);
            return;
        }

        const latestTweetGuid = latestNormalTweet.id;
        const tweetLink = `https://fxtwitter.com/${username}/status/${latestNormalTweet.id}`;

        if (latestTweetGuid && state.lastTweetGuid !== latestTweetGuid) {
            if (!isInitialTwitterCheck) {
                console.log(`New tweet found: ${tweetLink}`);
                const message = `<@&${roleId}> **${username}**さんが新しいツイートを投稿しました！\n${tweetLink}`;
                await sendNotification(message);
            } else {
                console.log(`Initial check complete. Monitoring for new tweets after ID: ${latestTweetGuid}`);
            }
            state.lastTweetGuid = latestTweetGuid;
            saveState();
        }
    } catch (error) {
        console.error('Failed to check Twitter:', error.message);
        if (error.message && (error.message.includes('401') || error.message.includes('auth') || error.message.includes('Session'))) {
            isTwitterInitialized = false;
        }
    } finally {
        isInitialTwitterCheck = false;
    }
}

function startHeartbeat() {
    const pushUrl = process.env.WATCHER_PUSH_URL;
    if (!pushUrl) {
        console.warn('WATCHER_PUSH_URL not set. Heartbeat disabled.');
        return;
    }

    const send = async () => {
        try {
            const resp = await axios.get(pushUrl);
            if (resp.status === 200) {
                console.log(`Heartbeat sent to ${pushUrl}`);
            } else {
                console.warn(`Heartbeat failed with status ${resp.status}`);
            }
        } catch (e) {
            console.error(`Heartbeat error: ${e.message}`);
        }
    };

    send();
    setInterval(send, 60 * 1000);
}

client.on('ready', async () => {
    console.log(`Notifier Bot logged in as ${client.user.tag}`);
    loadState();
    startHeartbeat();
    // await connectToOBS();

    // if (config.OBS_WEBSOCKET.enabled) {
    //     startStreamDurationMonitor();
    // }
    if (config.TWITTER_UPDATES?.enabled) {
        console.log('Starting Twitter monitoring via lightweight API...');
        isInitialTwitterCheck = true;
        checkTwitter();
        setInterval(checkTwitter, (config.CHECK_INTERVAL_SECONDS || 60) * 1000);
    }
});

client.on('guildScheduledEventCreate', async (event) => {
    if (!config.EVENT_CREATION.enabled || event.guildId !== config.EVENT_CREATION.serverId) return;

    console.log(`New event created: ${event.name}`);
    const message = `<@&${config.EVENT_CREATION.roleId}>\n**イベントが追加**されました\nhttps://discord.com/events/${event.guildId}/${event.id}`;
    await sendNotification(message);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const joinConfig = config.VOICE_STATE_UPDATES.find(c =>
        c.enabled &&
        c.userId === newState.id &&
        c.channelId === newState.channelId &&
        c.serverId === newState.guild.id &&
        oldState.channelId !== newState.channelId
    );

    if (joinConfig) {
        if (leaveTimers[joinConfig.channelId]) {
            console.log(`Re-join detected for ${joinConfig.type}. Canceling stream stop timer.`);
            clearTimeout(leaveTimers[joinConfig.channelId]);
            delete leaveTimers[joinConfig.channelId];
            return;
        }

        const now = Date.now();
        if (now - (notificationCooldowns[joinConfig.channelId] || 0) < NOTIFICATION_COOLDOWN_MS) {
            console.log(`Duplicate notification for ${joinConfig.type} detected. Ignoring.`);
            return;
        }
        notificationCooldowns[joinConfig.channelId] = now;

        console.log(`User ${newState.member.displayName} joined ${joinConfig.type}. Notifying and processing OBS...`);
        const message = `<@&${joinConfig.roleId}>\nhttps://discord.com/channels/${joinConfig.serverId}/${joinConfig.channelId}\nにて**${joinConfig.type}**が始まりました!!`;
        await sendNotification(message);

/*
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
*/
        return;
    }

    const leaveConfig = config.VOICE_STATE_UPDATES.find(c =>
        c.enabled &&
        c.userId === oldState.id &&
        c.channelId === oldState.channelId &&
        c.serverId === oldState.guild.id
    );

    if (leaveConfig) {
        const vc = await client.channels.fetch(leaveConfig.channelId);
        const targetUsersInVC = vc.members.filter(member => member.id === leaveConfig.userId);

        if (targetUsersInVC.size === 0 && isStreaming) {
            console.log(`Target user left ${leaveConfig.type}. Starting grace period before stopping stream...`);
            if (leaveTimers[leaveConfig.channelId]) {
                clearTimeout(leaveTimers[leaveConfig.channelId]);
            }
            leaveTimers[leaveConfig.channelId] = setTimeout(async () => {
                console.log(`Grace period ended for ${leaveConfig.type}. User did not rejoin. Stopping stream...`);
/*
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
*/
                delete leaveTimers[leaveConfig.channelId];
            }, STREAM_STOP_GRACE_PERIOD_MS);
        }
    }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("Fatal Login Error:", err.message);
});
