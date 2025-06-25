const { Client } = require('discord.js-selfbot-v13');
const RssParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const config = require('./config.json');
const client = new Client({ checkUpdate: false });
const parser = new RssParser();

const STATE_FILE_PATH = path.join(__dirname, 'state.json');
let state = { lastTweetGuid: null };

function loadState() {
    if (fs.existsSync(STATE_FILE_PATH)) {
        try {
            const loadedState = JSON.parse(fs.readFileSync(STATE_FILE_PATH));
            state.lastTweetGuid = loadedState.lastTweetGuid || null;
            console.log('State loaded successfully.');
        } catch (e) { console.error('Failed to parse state file.', e) }
    } else { console.log('No state file found, starting fresh.'); }
}
function saveState() {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

async function sendNotification(message) {
    try {
        const channel = await client.channels.fetch(config.NOTIFICATION_CHANNEL_ID);
        await channel.send(message);
    } catch (error) { console.error('Error sending notification:', error); }
}

async function checkTwitter() {
    if (!config.TWITTER_UPDATES.enabled) return;
    const { rssAppUrl, roleId } = config.TWITTER_UPDATES;
    try {
        const feed = await parser.parseURL(rssAppUrl);
        const twitterItems = feed.items.filter(item => 
            item.link && item.title && (item.link.includes('x.com') || item.link.includes('twitter.com')) && 
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
    } catch (error) { console.error(`Failed to fetch Twitter feed:`, error.message); }
}

client.on('ready', async () => {
    console.log(`Notifier Bot logged in as ${client.user.tag}`);
    loadState();
    if (config.TWITTER_UPDATES.enabled) {
        console.log('Starting Twitter monitoring...');
        checkTwitter(); // 初回実行
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
    const vcConfig = config.VOICE_STATE_UPDATES.find(c =>
        c.enabled && c.userId === newState.id && c.channelId === newState.channelId &&
        c.serverId === newState.guild.id && oldState.channelId !== newState.channelId
    );
    if (vcConfig) {
        console.log(`User ${newState.member.displayName} joined ${vcConfig.type}`);
        const message = `<@&${vcConfig.roleId}>\nhttps://discord.com/channels/${vcConfig.serverId}/${vcConfig.channelId}\nにて**${vcConfig.type}**が始まりました!!`;
        await sendNotification(message);
    }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("Fatal Login Error:", err.message);
});
