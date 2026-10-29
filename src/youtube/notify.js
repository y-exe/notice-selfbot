const { shortUrl } = require('./feed');

const YOUTUBE_SEEN_LIMIT = 1000;

function channelKey(target) {
    return target.channelId || target.handle;
}

function targetName(target, video) {
    return (
        target.label ||
        target.handle ||
        (video && video.channelTitle) ||
        (video && video.channelId) ||
        'YouTube'
    );
}

function kindText(kind) {
    if (kind === 'live') return 'ライブ配信を開始しました';
    if (kind === 'upcoming') return 'ライブ配信を予定しています';
    return '新しい動画を投稿しました';
}

function formatYoutubeMessage(target, video) {
    const mention = target.roleId ? `<@&${target.roleId}> ` : '';
    return (
        `${mention}**${targetName(target, video)}**さんが` +
        `${kindText(video.kind)}！\n${video.title}\n${shortUrl(video.videoId)}`
    );
}

function ensureYoutubeState(state) {
    if (
        !state.youtubeBaselineInitialized ||
        typeof state.youtubeBaselineInitialized !== 'object' ||
        Array.isArray(state.youtubeBaselineInitialized)
    )
        state.youtubeBaselineInitialized = {};
    if (!Array.isArray(state.youtubeSeenVideoIds))
        state.youtubeSeenVideoIds = [];
    if (
        !state.lastYoutubeVideoIds ||
        typeof state.lastYoutubeVideoIds !== 'object' ||
        Array.isArray(state.lastYoutubeVideoIds)
    )
        state.lastYoutubeVideoIds = {};
    return state;
}

// 動画ID単位で重複を除外する。ライブ終了後に同じIDで
// アーカイブ公開されてもURLが同一のため2重通知しない。
async function sendYoutubeVideo({
    target,
    video,
    state,
    saveState,
    send,
    logger = console,
}) {
    ensureYoutubeState(state);
    if (state.youtubeSeenVideoIds.includes(video.videoId)) return false;
    if (target.videosOnly && !video.detailsVerified) {
        logger.warn?.(
            `YouTube動画の種別を判定できないため通知を保留します: ${video.videoId}`,
        );
        return false;
    }
    const excluded =
        target.videosOnly && (video.kind !== 'video' || video.isLiveStream);
    if (!excluded)
        await send(
            formatYoutubeMessage(target, video),
            target.notificationChannelId,
        );
    state.youtubeSeenVideoIds.push(video.videoId);
    state.youtubeSeenVideoIds =
        state.youtubeSeenVideoIds.slice(-YOUTUBE_SEEN_LIMIT);
    state.lastYoutubeVideoIds[channelKey(target)] = video.videoId;
    saveState();
    if (excluded) return false;
    logger.log?.(
        `YouTube通知を送信しました: ${targetName(target, video)}/${video.videoId}`,
    );
    return true;
}

module.exports = {
    YOUTUBE_SEEN_LIMIT,
    channelKey,
    targetName,
    kindText,
    formatYoutubeMessage,
    ensureYoutubeState,
    sendYoutubeVideo,
};
