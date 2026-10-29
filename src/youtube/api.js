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
                title: (item.snippet && item.snippet.title) || '(タイトル不明)',
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

async function enrichVideos(
    videos,
    { apiKey, fetchImpl = fetch, includeLiveStreamingDetails = false } = {},
) {
    if (!apiKey || !videos.length) return videos;
    const ids = [...new Set(videos.map((v) => v.videoId))].slice(0, 50);
    const url =
        'https://www.googleapis.com/youtube/v3/videos' +
        `?part=${includeLiveStreamingDetails ? 'snippet,liveStreamingDetails' : 'snippet'}&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetchImpl(url, {
        headers: { 'user-agent': YOUTUBE_USER_AGENT },
    });
    if (!res.ok)
        throw new Error(
            `YouTube Data APIの取得に失敗しました: HTTP ${res.status}`,
        );
    const data = await res.json();
    const byId = {};
    for (const item of data.items || []) {
        const broadcast = item.snippet && item.snippet.liveBroadcastContent;
        byId[item.id] = {
            detailsVerified: ['none', 'live', 'upcoming'].includes(broadcast),
            isLiveStream:
                !!item.liveStreamingDetails ||
                broadcast === 'live' ||
                broadcast === 'upcoming',
            title: (item.snippet && item.snippet.title) || undefined,
            kind:
                broadcast === 'live'
                    ? 'live'
                    : broadcast === 'upcoming'
                      ? 'upcoming'
                      : 'video',
        };
    }
    return videos.map((video) => ({
        ...video,
        title:
            (byId[video.videoId] && byId[video.videoId].title) || video.title,
        kind: (byId[video.videoId] && byId[video.videoId].kind) || 'video',
        detailsVerified: byId[video.videoId]?.detailsVerified === true,
        isLiveStream: byId[video.videoId]?.isLiveStream,
    }));
}

module.exports = {
    API_BASE,
    uploadsPlaylistId,
    fetchLatestVideos,
    enrichVideos,
};
