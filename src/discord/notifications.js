function createNotifier(client, channelId) {
    return async (message) => {
        const channel = await client.channels.fetch(channelId);
        await channel.send(message);
    };
}
module.exports = { createNotifier };
