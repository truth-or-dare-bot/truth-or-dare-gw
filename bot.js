const {
    Client,
    LimitedCollection,
    MessageButton,
    MessageActionRow,
    Message
} = require('discord.js');
const IPC = require('./IPC.js');
const { PREFIX } = process.env;
const COMMANDS = ['truth', 't', 'dare', 'd', 'nhie', 'n', 'wyr', 'w'];

class TOD extends Client {
    constructor() {
        super({
            intents: ['GUILD_MESSAGES'],
            makeCache: () => new LimitedCollection({ maxSize: 0 })
        });
        this.ipc = new IPC(this);
    }

    /**
     *
     * @param {import('./IPC').IncomingMessage} message
     */
    run(message) {
        console.log('running?');
        this.clusterId = message.cluster;
        this.options.shardCount = message.totalShards;
        const [start, end] = message.shards;
        this.options.shards = Array.from({ length: end - start + 1 }, (_, i) => i + start);
        console.log(this.options.shardCount);
        console.log(this.options.shards);
        return this.login();
    }
}

module.exports = TOD;

const client = new TOD();

client.on('raw', async data => {
    if (data.t !== 'MESSAGE_CREATE') return;
    const message = new Message(client, data.d);
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const command = message.content.slice(PREFIX.length).split(' ')[0];
    if (!COMMANDS.includes(command.toLowerCase())) return;

    // @ts-ignore
    await client.api.channels[message.channelId].messages.post({
        data: {
            content:
                "Commands have been moved to slash commands! Type `/` to see a list of commands. If you don't see them, ask a server admin to click the button below to add my slash commands.",
            components: [
                // @ts-ignore
                new MessageActionRow()
                    .addComponents(
                        new MessageButton({
                            url: `https://discord.com/oauth2/authorize?client_id=692045914436796436&permissions=19456&scope=bot%20applications.commands&guild_id=${message.guildId}`,
                            style: 'LINK',
                            label: 'Add Slash Commands'
                        })
                    )
                    .toJSON()
            ]
        }
    });
});
