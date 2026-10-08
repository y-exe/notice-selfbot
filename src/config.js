const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
}
function twitterTargets(config) {
    const targets = config.TWITTER_UPDATES;
    return (Array.isArray(targets) ? targets : targets ? [targets] : []).filter(
        (t) => t && t.enabled !== false,
    );
}
module.exports = { root, loadConfig, twitterTargets };
