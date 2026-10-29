function createNotifier(client, channelId) {
    return async (message, destinationChannelId = channelId) => {
        const channel = await client.channels.fetch(
            destinationChannelId || channelId,
        );
        await channel.send(message);
    };
}
module.exports = { createNotifier };
