require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const configPath = process.env.ANGELIC_CONFIG_PATH || '/data/angelic-angel.toml';
let child;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { stopping = true; if (child) child.kill(signal); else process.exit(0); });
}
function run(command) {
    return new Promise((resolve, reject) => {
        child = spawn('angelic-angel', ['--config', configPath, command], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            child = null;
            if (stopping) process.exit(0);
            if (code === 0) resolve();
            else reject(new Error(`Angelic-Angel ${command} failed (${code ?? signal})`));
        });
    });
}
async function main() {
    const auth = process.env.TWITTER_AUTH_TOKEN;
    const ct0 = process.env.TWITTER_CT0;
    if (!auth || !ct0) throw new Error('TWITTER_AUTH_TOKEN and TWITTER_CT0 are required');
    if (!process.env.WEBHOOK_ENDPOINT) throw new Error('WEBHOOK_ENDPOINT is required');
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const credentials = `[twitter]\nauth_token = ${JSON.stringify(auth)}\nct0 = ${JSON.stringify(ct0)}\n\n`;
    // Preserve the persistent push subscription, refresh cookies from Kubernetes Secret.
    config = config.replace(/^\[twitter\][\s\S]*?(?=^\[|$(?![\s\S]))/m, '');
    fs.writeFileSync(configPath, credentials + config, { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    // Avoid registering before the Discord receiver is available.
    while (!stopping) {
        try {
            const response = await fetch(process.env.WEBHOOK_ENDPOINT, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!/^\[registration\]/m.test(config)) await run('register');
    await run('listen');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
