function createVoiceHandler(config, send, now = Date.now) {
    const cooldowns = new Map();
    return async (oldState, newState) => {
        const target = config.VOICE_STATE_UPDATES?.find(
            (t) =>
                t.enabled &&
                t.userId === newState.id &&
                t.channelId === newState.channelId &&
                t.serverId === newState.guild?.id &&
                oldState.channelId !== newState.channelId,
        );
        if (!target) return;
        const key = `${target.serverId}:${target.channelId}`;
        const timestamp = now();
        if (cooldowns.has(key) && timestamp - cooldowns.get(key) < 180000)
            return;
        const mention = target.roleId ? `<@&${target.roleId}>\n` : '';
        cooldowns.set(key, timestamp);
        try {
            await send(
                `${mention}https://discord.com/channels/${target.serverId}/${target.channelId}\nにて**${target.type}**が始まりました!!`,
            );
        } catch (error) {
            if (cooldowns.get(key) === timestamp) cooldowns.delete(key);
            throw error;
        }
    };
}
module.exports = { createVoiceHandler };
