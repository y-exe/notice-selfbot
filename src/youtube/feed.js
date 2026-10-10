const YOUTUBE_FEED_BASE =
    'https://www.youtube.com/xml/feeds/videos.xml';
const YOUTUBE_HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const YOUTUBE_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function feedUrl(channelId) {
    return `${YOUTUBE_FEED_BASE}?channel_id=${channelId}`;
}

// フィード内の yt:channelId は "UC" 接頭辞が付かないことがあるため、
// 比較時は接頭辞の有無を吸収する。
function sameChannelId(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const strip = (id) => id.replace(/^UC/, '');
    return strip(a) === strip(b);
}

// 通知URLは常に https://youtu.be/動画ID の最短形にする
function shortUrl(videoId) {
    return `https://youtu.be/${videoId}`;
}

function unescapeXml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) =>
            String.fromCodePoint(Number(code)),
        )
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
            String.fromCodePoint(parseInt(hex, 16)),
        )
        .replace(/&amp;/g, '&');
}

function pickTag(block, tag) {
    const match = block.match(
        new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`),
    );
    return match ? unescapeXml(match[1].trim()) : null;
}

// Atomフィード内の<entry>を動画情報に変換する。RSS・WebSub共通。
function parseFeedEntries(xml) {
    if (typeof xml !== 'string') return [];
    const entries = [];
    for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const block = match[1];
        const videoId = pickTag(block, 'yt:videoId');
        if (!videoId) continue;
        const authorBlock = block.match(/<author>([\s\S]*?)<\/author>/);
        entries.push({
            videoId,
            title: pickTag(block, 'title') || '(タイトル不明)',
            published: pickTag(block, 'published'),
            updated: pickTag(block, 'updated'),
            channelId: pickTag(block, 'yt:channelId'),
            channelTitle: authorBlock ? pickTag(authorBlock[1], 'name') : null,
            kind: 'video',
        });
    }
    return entries;
}

// YouTubeはレート制限時などにHTTP 200で仮フィードを返すことがある。
// これを正常な「新着なし」と区別し、再試行させる。
function isPlaceholderFeed(xml) {
    return (
        typeof xml === 'string' &&
        (xml.includes('This is a static file') ||
            xml.includes('<title>YouTube video feed</title>'))
    );
}
// ハンドルページのHTMLからチャンネルIDを抜き出す。
// ページ内に他チャンネルのIDも含まれるため、所有者を示すcanonicalを優先する。
function resolveChannelIdFromHtml(html) {
    if (typeof html !== 'string') return null;
    const canonical = html.match(
        /<link[^>]*rel="canonical"[^>]*href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)"/,
    );
    if (canonical) return canonical[1];
    const canonicalAlt = html.match(
        /https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/,
    );
    if (canonicalAlt) return canonicalAlt[1];
    const external = html.match(/"externalChannelId":"(UC[A-Za-z0-9_-]+)"/);
    if (external) return external[1];
    return null;
}

module.exports = {
    YOUTUBE_FEED_BASE,
    YOUTUBE_HUB_URL,
    YOUTUBE_USER_AGENT,
    feedUrl,
    shortUrl,
    sameChannelId,
    isPlaceholderFeed,
    parseFeedEntries,
    resolveChannelIdFromHtml,
};
