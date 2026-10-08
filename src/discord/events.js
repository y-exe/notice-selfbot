function createEventHandler(config, send) {
    return async (event) => {
        const target = config.EVENT_CREATION;
        if (!target?.enabled || event.guildId !== target.serverId) return;
        const mention = target.roleId ? `<@&${target.roleId}>\n` : '';
        await send(
            `${mention}**イベントが追加**されました\nhttps://discord.com/events/${event.guildId}/${event.id}`,
        );
    };
}
module.exports = { createEventHandler };
