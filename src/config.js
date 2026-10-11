const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
function loadConfig(configPath = process.env.CONFIG_PATH || path.join(root, 'config.json')) {
    if (!fs.existsSync(configPath)) {
        throw new Error('設定ファイルがありません。CONFIG_PATHで指定するか、config.example.jsonをコピーして外部から配置してください。');
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('設定ファイルはJSONオブジェクトで指定してください。');
    }
    return config;
}
function twitterTargets(config) {
    const targets = config.TWITTER_UPDATES;
    return (Array.isArray(targets) ? targets : targets ? [targets] : []).filter(
        (t) => t && t.enabled !== false,
    );
}
function youtubeTargets(config) {
    const targets = (config || {}).YOUTUBE_UPDATES;
    return (Array.isArray(targets) ? targets : targets ? [targets] : []).filter(
        (t) => t && t.enabled !== false,
    );
}
module.exports = { root, loadConfig, twitterTargets, youtubeTargets };
