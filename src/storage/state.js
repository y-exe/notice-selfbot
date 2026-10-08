const fs = require('node:fs');
function createStateStore(file, targets = [], logger = console) {
    let state = {
        lastTweetGuid: null,
        lastTweetGuids: {},
        twitterPushSeenIds: [],
    };
    if (fs.existsSync(file)) {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded))
            throw new Error('状態ファイルの形式が不正です');
        state = { ...state, ...loaded };
    }
    if (
        !state.lastTweetGuids ||
        typeof state.lastTweetGuids !== 'object' ||
        Array.isArray(state.lastTweetGuids)
    )
        state.lastTweetGuids = {};
    if (!Array.isArray(state.twitterPushSeenIds)) state.twitterPushSeenIds = [];
    if (targets.length === 1 && state.lastTweetGuid) {
        const username = targets[0].username || targets[0].nitterUsername;
        if (username && !state.lastTweetGuids[username])
            state.lastTweetGuids[username] = state.lastTweetGuid;
    }
    logger.log('通知の保存状態を読み込みました');
    return {
        state,
        save: () => fs.writeFileSync(file, JSON.stringify(state, null, 2)),
    };
}
module.exports = { createStateStore };
