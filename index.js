require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
// const OBSWebSocket = require('obs-websocket-js').default;
const axios = require('axios');
const Parser = require('rss-parser');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const config = require('./config.json');
const client = new Client({ checkUpdate: false });
// const obs = new OBSWebSocket();
const rssParser = new Parser({
    requestOptions: {
        headers: {
            'User-Agent': 'NotifierBot/1.0 (+https://github.com/)'
        }
    }
});

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
let rssBrowser = null;


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

async function checkTwitter() {
    if (!config.TWITTER_UPDATES.enabled) return;

    const { nitterUsername, rssUrl, rssUrls, roleId } = config.TWITTER_UPDATES;
    const feedUrls = Array.isArray(rssUrls) && rssUrls.length > 0 ? rssUrls : [rssUrl];

    try {
        const { feed, sourceUrl } = await fetchFirstAvailableTwitterFeed(feedUrls);
        const latestTweet = feed.items?.[0];

        if (!latestTweet) {
            console.warn(`No tweet items found in RSS feed: ${sourceUrl}`);
            return;
        }

        const latestTweetGuid = latestTweet.guid || latestTweet.id || latestTweet.link;
        const latestTweetLink = formatTweetUrlForDiscord(latestTweet.link || sourceUrl);

        if (latestTweetGuid && state.lastTweetGuid !== latestTweetGuid) {
            if (!isInitialTwitterCheck) {
                console.log(`New tweet found: ${latestTweetLink}`);
                const message = `<@&${roleId}> **${nitterUsername}**さんが新しいツイートを投稿しました！\n${latestTweetLink}`;
                await sendNotification(message);
            } else {
                console.log(`Initial check complete. Monitoring for new tweets after GUID: ${latestTweetGuid}`);
            }
            state.lastTweetGuid = latestTweetGuid;
            saveState();
        }
    } catch (error) {
        console.error('Failed to fetch or parse all configured Twitter RSS feeds:', error.message);
    } finally {
        isInitialTwitterCheck = false;
    }
}

async function fetchFirstAvailableTwitterFeed(feedUrls) {
    const errors = [];

    for (const sourceUrl of feedUrls.filter(Boolean)) {
        try {
            const rssText = await fetchRssTextWithPuppeteer(sourceUrl);

            if (/^\s*<!doctype html/i.test(rssText) || /^\s*<html/i.test(rssText)) {
                throw new Error('returned HTML instead of RSS XML');
            }

            const feed = await rssParser.parseString(rssText);
            return { feed, sourceUrl };
        } catch (error) {
            errors.push(`${sourceUrl}: ${error.message}`);
            console.warn(`Twitter RSS source unavailable (${sourceUrl}): ${error.message}`);
        }
    }

    throw new Error(errors.join(' / ') || 'no RSS URLs configured');
}

function formatTweetUrlForDiscord(tweetUrl) {
    return tweetUrl
        .replace(/^https?:\/\/nitter\.privacyredirect\.com\//i, 'https://fxtwitter.com/')
        .replace(/#m$/, '');
}

async function fetchRssTextWithPuppeteer(sourceUrl) {
    const browser = await getRssBrowser();
    const page = await browser.newPage();

    try {
        await page.setUserAgent('NotifierBot/1.0');
        await page.setExtraHTTPHeaders({
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
        });

        await page.goto(sourceUrl, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});

        return await getDocumentText(page);
    } finally {
        await page.close().catch(() => {});
    }
}

async function getDocumentText(page) {
    let lastError;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return await page.evaluate(() => {
                const bodyText = document.body?.innerText?.trim() || '';

                if (/^<\?xml/i.test(bodyText) || /^<rss/i.test(bodyText)) {
                    return bodyText;
                }

                return document.documentElement.outerHTML;
            });
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    throw lastError;
}

async function getRssBrowser() {
    if (rssBrowser && rssBrowser.isConnected()) {
        return rssBrowser;
    }

    const executablePath = getBrowserExecutablePath();
    const launchOptions = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }

    try {
        rssBrowser = await puppeteer.launch(launchOptions);
    } catch (error) {
        throw new Error(`${error.message} Install Puppeteer's browser with "npx puppeteer browsers install chrome" or set PUPPETEER_EXECUTABLE_PATH.`);
    }

    return rssBrowser;
}

function getBrowserExecutablePath() {
    const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH || config.TWITTER_UPDATES.browserExecutablePath;
    if (configuredPath && fs.existsSync(configuredPath)) {
        return configuredPath;
    }

    const candidates = [
        path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LocalAppData || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome'
    ];

    return candidates.find(candidate => candidate && fs.existsSync(candidate));
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
    if (config.TWITTER_UPDATES.enabled) {
        console.log('Starting Twitter monitoring...');
        isInitialTwitterCheck = true;
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
