const { YOUTUBE_USER_AGENT } = require('./feed');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// アップロード済み動画プレイリストIDはチャンネルIDのUCをUUに置換したもの。
function uploadsPlaylistId(channelId) {
    return channelId.replace(/^UC/, 'UU');
}

// Data APIを一次取得に使う。RSS側のスロットルを受けない。
async function fetchLatestVideos({
    channelId,
    apiKey,
    fetchImpl = fetch,
    maxResults = 10,
}) {
    const url =
        `${API_BASE}/playlistItems?part=snippet,contentDetails` +
        `&playlistId=${uploadsPlaylistId(channelId)}` +
        `&maxResults=${maxResults}&key=${apiKey}`;
    const res = await fetchImpl(url, {
        headers: { 'user-agent': YOUTUBE_USER_AGENT },
    });
    if (!res.ok)
        throw new Error(
            `YouTube Data APIの取得に失敗しました: HTTP ${res.status}`,
        );
    const data = await res.json();
    return (data.items || [])
        .map((item) => {
            const videoId =
                (item.contentDetails && item.contentDetails.videoId) || item.id;
            if (!videoId) return null;
            return {
                videoId,
                title:
                    (item.snippet && item.snippet.title) || '(タイトル不明)',
                published:
                    (item.contentDetails &&
                        item.contentDetails.videoPublishedAt) ||
                    (item.snippet && item.snippet.publishedAt) ||
                    null,
                updated: null,
                channelId,
                channelTitle:
                    (item.snippet && item.snippet.channelTitle) || null,
                kind: 'video',
            };
        })
        .filter(Boolean);
}

module.exports = { API_BASE, uploadsPlaylistId, fetchLatestVideos };
