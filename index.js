require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
// const OBSWebSocket = require('obs-websocket-js').default;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createPushServer } = require('./twitter-push');

const config = require('./config.json');
const client = new Client({ checkUpdate: false });
// const obs = new OBSWebSocket();

const STATE_FILE_PATH = path.join(__dirname, 'state.json');

const NOTIFICATION_COOLDOWN_MS = 180 * 1000; // 3分 (通知のクールダウン)
const STREAM_STOP_GRACE_PERIOD_MS = 180 * 1000; // 3分 (配信停止までの猶予時間)
const STREAM_DURATION_LIMIT_MS = 11.5 * 60 * 60 * 1000; // 11時間30分 (配信時間の上限)

const TWITTER_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let state = {
    lastTweetGuid: null,
    lastTweetGuids: {}
};
let notificationCooldowns = {};
let leaveTimers = {};
let isStreaming = false;
let activeOBSSourceInfo = null;
let streamStartTime = null;
let initialCheckedUsers = new Set();
let cachedTwitterUserIds = {};

function loadState() {
    if (fs.existsSync(STATE_FILE_PATH)) {
        try {
            state = JSON.parse(fs.readFileSync(STATE_FILE_PATH));
            if (!state.lastTweetGuids || typeof state.lastTweetGuids !== 'object') {
                state.lastTweetGuids = {};
            }
            if (state.lastTweetGuid && !state.lastTweetGuids['YamakawaTeruki']) {
                state.lastTweetGuids['YamakawaTeruki'] = state.lastTweetGuid;
            }
            console.log('State loaded successfully. Current tweet states:', JSON.stringify(state.lastTweetGuids));
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

async function getTwitterUserId(username, authToken, ct0) {
    if (cachedTwitterUserIds[username]) return cachedTwitterUserIds[username];

    const url = `https://x.com/i/api/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName?variables=${encodeURIComponent(JSON.stringify({ screen_name: username }))}`;
    const res = await fetch(url, {
        headers: {
            'authorization': `Bearer ${TWITTER_BEARER_TOKEN}`,
            'cookie': `auth_token=${authToken}; ct0=${ct0}`,
            'x-csrf-token': ct0,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch user profile for ${username}: HTTP ${res.status}`);
    }

    const data = await res.json();
    const userId = data?.data?.user?.result?.rest_id;
    if (!userId) {
        throw new Error(`User ID not found for ${username}`);
    }

    cachedTwitterUserIds[username] = userId;
    return userId;
}

async function fetchLatestTweet(username) {
    const authToken = process.env.TWITTER_AUTH_TOKEN;
    const ct0 = process.env.TWITTER_CT0;

    if (!authToken || !ct0) {
        console.warn('TWITTER_AUTH_TOKEN or TWITTER_CT0 not set. Skipping Twitter check.');
        return null;
    }

    const userId = await getTwitterUserId(username, authToken, ct0);

    const variables = {
        userId: userId,
        count: 10,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
        withV2Timeline: true
    };
    const features = {
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        articles_preview_enabled: true,
        tweetypie_unmention_optimization_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        tweet_awards_web_tipping_enabled: false,
        creator_subscriptions_quote_tweet_preview_enabled: false,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        rweb_video_timestamps_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false
    };

    const url = `https://x.com/i/api/graphql/V7H0Ap3_Hh2FyS75OCDO3Q/UserTweets?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
    const res = await fetch(url, {
        headers: {
            'authorization': `Bearer ${TWITTER_BEARER_TOKEN}`,
            'cookie': `auth_token=${authToken}; ct0=${ct0}`,
            'x-csrf-token': ct0,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch user tweets for ${username}: HTTP ${res.status}`);
    }

    const data = await res.json();
    const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];

    for (const instr of instructions) {
        if (instr.type === 'TimelineAddEntries') {
            for (const entry of instr.entries) {
                if (entry.content?.entryType === 'TimelineTimelineItem') {
                    const result = entry.content.itemContent?.tweet_results?.result;
                    if (!result) continue;
                    const tweet = result.tweet || result;
                    const legacy = tweet.legacy;
                    if (!legacy) continue;

                    const isRetweet = !!legacy.retweeted_status_result;
                    const isReply = !!legacy.in_reply_to_status_id_str;

                    // リツイートやリプライは除外
                    if (isRetweet || isReply) continue;

                    const tweetId = legacy.id_str || tweet.rest_id;
                    return {
                        id: tweetId,
                        text: legacy.full_text,
                        url: `https://fxtwitter.com/${username}/status/${tweetId}`
                    };
                }
            }
        }
    }

    return null;
}

async function checkTwitter() {
    if (!config.TWITTER_UPDATES) return;

    const rawTargets = Array.isArray(config.TWITTER_UPDATES)
        ? config.TWITTER_UPDATES
        : [config.TWITTER_UPDATES];

    const targets = rawTargets.filter(t => t && t.enabled !== false);

    for (const target of targets) {
        const username = target.username || target.nitterUsername;
        if (!username) continue;

        const roleId = target.roleId;

        try {
            const latestTweet = await fetchLatestTweet(username);

            if (!latestTweet) {
                if (!initialCheckedUsers.has(username)) {
                    console.log(`[${username}] Initial check complete. No tweets found yet, will monitor for new posts.`);
                    initialCheckedUsers.add(username);
                }
                continue;
            }

            const latestTweetGuid = latestTweet.id;
            const tweetLink = latestTweet.url;
            const lastKnownId = state.lastTweetGuids[username];

            if (latestTweetGuid && lastKnownId !== latestTweetGuid) {
                if (initialCheckedUsers.has(username)) {
                    console.log(`[${username}] New tweet found: ${tweetLink}`);
                    const roleMention = roleId ? `<@&${roleId}> ` : '';
                    const message = `${roleMention}**${username}**さんが新しいツイートを投稿しました！\n${tweetLink}`;
                    await sendNotification(message);
                } else {
                    console.log(`[${username}] Initial check complete. Monitoring after ID: ${latestTweetGuid}`);
                }
                state.lastTweetGuids[username] = latestTweetGuid;
                state.lastTweetGuid = latestTweetGuid;
                saveState();
            }
            initialCheckedUsers.add(username);
        } catch (error) {
            console.error(`[${username}] Failed to check Twitter:`, error.message);
        }
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

function scheduleNextTwitterCheck() {
    const minSeconds = config.CHECK_INTERVAL_MIN_SECONDS || 180; // 3分
    const maxSeconds = config.CHECK_INTERVAL_MAX_SECONDS || 300; // 5分
    const intervalSeconds = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;

    console.log(`Next Twitter check scheduled in ${intervalSeconds}s (${(intervalSeconds / 60).toFixed(1)}m)`);

    setTimeout(async () => {
        try {
            await checkTwitter();
        } catch (error) {
            console.error('Error during scheduled Twitter check:', error);
        } finally {
            scheduleNextTwitterCheck();
        }
    }, intervalSeconds * 1000);
}

let twitterPushServer;
client.on('ready', async () => {
    console.log(`Notifier Bot logged in as ${client.user.tag}`);
    loadState();
    startHeartbeat();
    // await connectToOBS();

    // if (config.OBS_WEBSOCKET.enabled) {
    //     startStreamDurationMonitor();
    // }
    if (config.TWITTER_UPDATES) {
        if ((process.env.TWITTER_SOURCE || config.TWITTER_SOURCE || 'angelic-angel') === 'angelic-angel') {
            if (!twitterPushServer) {
                const targets = Array.isArray(config.TWITTER_UPDATES) ? config.TWITTER_UPDATES : [config.TWITTER_UPDATES];
                twitterPushServer = createPushServer({
                    targets, state, saveState, isReady: () => client.isReady(),
                    send: async message => {
                        const channel = await client.channels.fetch(config.NOTIFICATION_CHANNEL_ID);
                        await channel.send(message);
                    }
                });
                twitterPushServer.on('error', error => {
                    console.error('Twitter push server failed:', error.message);
                    process.exitCode = 1;
                    client.destroy();
                });
                twitterPushServer.listen(Number(process.env.TWITTER_PUSH_PORT || 8787), process.env.TWITTER_PUSH_HOST || '127.0.0.1', () => {
                    console.log('Twitter monitoring via Angelic-Angel: POST /twitter/push');
                });
            }
            return;
        }
        console.log('Starting Twitter monitoring via native lightweight GraphQL API with randomized interval (3-5m)...');
        checkTwitter().finally(() => {
            scheduleNextTwitterCheck();
        });
    }
});

client.on('guildScheduledEventCreate', async (event) => {
    if (!config.EVENT_CREATION?.enabled || event.guildId !== config.EVENT_CREATION.serverId) return;

    console.log(`New event created: ${event.name}`);
    const message = `<@&${config.EVENT_CREATION.roleId}>\n**イベントが追加**されました\nhttps://discord.com/events/${event.guildId}/${event.id}`;
    await sendNotification(message);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!config.VOICE_STATE_UPDATES) return;

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
