const {
    Client,
    LimitedCollection,
    MessageButton,
    MessageActionRow,
    Message,
    Constants: { ShardEvents, WSCodes, Events }
} = require('discord.js');
const { RPCErrorCodes } = require('discord-api-types/v9');
const UNRECOVERABLE_CLOSE_CODES = Object.keys(WSCodes).slice(1).map(Number);
const UNRESUMABLE_CLOSE_CODES = [
    RPCErrorCodes.UnknownError,
    RPCErrorCodes.InvalidPermissions,
    RPCErrorCodes.InvalidClientId
];
const IPC = require('./IPC.js');
const { PREFIX, TOPGG_KEY } = process.env;
const OWNERS = process.env.OWNERS?.split(',') || [];
const COMMANDS = ['truth', 't', 'dare', 'd', 'nhie', 'n', 'wyr', 'w', 'help', 'tod', 'paranoia'];

class TOD extends Client {
    constructor() {
        super({
            intents: ['GUILDS', 'GUILD_MESSAGES'],
            makeCache: () => new LimitedCollection({ maxSize: 0 }),
            presence: { activities: [{ name: 'Truth or Dare • /help', type: 'PLAYING' }] },
            invalidRequestWarningInterval: 250
        });
        this.ipc = new IPC(this);
        this.guildList = new Set();
        this.commandStats = Object.fromEntries(COMMANDS.map(c => [c, 0]));
        this.commandStats.mentioned = 0;
        this.commandStats['memory--stats'] = 0;
        this.commandStats['guild--count'] = 0;
        this.commandStats['cluster--status'] = 0;
        this.commandStats['command--stats'] = 0;
        this.commandStats['_eval'] = 0;

        this.rollingStats = {
            current: 0,
            past: [],
            lastUpdate: Date.now()
        };
        setInterval(() => {
            this.rollingStats.past.unshift(this.rollingStats.current);
            if (this.rollingStats.past.length > 24) this.rollingStats.past.pop();
            this.rollingStats.current = 0;
            this.rollingStats.lastUpdate = Date.now();
        }, 60 * 60 * 1000);
    }

    /**
     *
     * @param {import('./IPC').IncomingMessage} message
     */
    run(message) {
        this.clusterId = message.cluster;
        this.options.shardCount = message.totalShards;
        const [start, end] = message.shards;
        this.options.shards = Array.from({ length: end - start + 1 }, (_, i) => i + start);
        console.log(` -- [CLUSTER START] ${this.clusterId}`);

        if (this.clusterId === 1) setInterval(postTopgg, 30 * 60 * 1000);

        return this.login();
    }
}

module.exports = TOD;

const client = new TOD();

client.on('raw', async data => {
    if (data.t !== 'MESSAGE_CREATE') return;
    const message = new Message(client, data.d);
    if (message.author.bot) return;

    const mentioned = new RegExp(`^<@!?${client.user.id}>$`).test(message.content);

    if (!message.content.startsWith(PREFIX) && !mentioned) return;

    const command = message.content.slice(PREFIX.length).split(' ')[0];
    if (command === 'memory--stats') {
        client.commandStats['memory--stats']++;
        const memory = await client.ipc.memoryUsage();
        for (const k in memory) {
            memory[k] = (memory[k] / 1024 / 1024).toFixed(2) + ' MB';
        }
        // @ts-ignore
        await client.api.channels[message.channelId].messages
            .post({
                data: {
                    content: '```js\n' + require('util').inspect(memory) + '\n```'
                }
            })
            .catch(err => null);
    } else if (command === 'guild--count') {
        client.commandStats['guild--count']++;
        const guildCounts = await client.ipc.broadcastEval('this.guildList.size');
        // @ts-ignore
        await client.api.channels[message.channelId].messages
            .post({
                data: {
                    content: `This cluster: ${client.guildList.size.toLocaleString()}\nTotal Guilds: ${guildCounts
                        .reduce((a, c) => a + c, 0)
                        .toLocaleString()}`
                }
            })
            .catch(err => null);
    } else if (command === 'cluster--status') {
        client.commandStats['cluster--status']++;
        const clusters = await client.ipc.broadcastEval('this.isReady() ? "online" : "offline"');
        // @ts-ignore
        await client.api.channels[message.channelId].messages
            .post({
                data: {
                    content:
                        '```js\n' +
                        require('util').inspect(
                            Object.fromEntries([...clusters.entries()].map(([a, b]) => [a + 1, b]))
                        ) +
                        '\n```'
                }
            })
            .catch(err => null);
    } else if (command === 'command--stats') {
        client.commandStats['command--stats']++;
        const totals = await client.ipc.broadcastEval('[this.rollingStats, this.commandStats]');
        const [rollingStats, commandStats] = totals.reduce(([r, c], [r1, c1], i) => [
            {
                current: r.current + r1.current,
                past: Array.from(
                    { length: Math.max(r.past.length, r1.past.length) },
                    (_, k) => (r.past[k] || 0) + (r1.past[k] || 0)
                ),
                lastUpdate: (r.lastUpdate * i + r1.lastUpdate) / (i + 1)
            },
            Object.fromEntries(Object.entries(c).map(([name, count]) => [name, c1[name] + count]))
        ]);
        // @ts-ignore
        await client.api.channels[message.channelId].messages
            .post({
                data: {
                    content: `Usage since <t:${
                        (rollingStats.lastUpdate / 1000) | 0
                    }:R>: ${rollingStats.current.toLocaleString()}\nAverage Usage/h: ${
                        rollingStats.past.reduce((a, c) => a + c, 0) / rollingStats.past.length
                    }\n__Totals:__\n${Object.entries(commandStats)
                        .filter(
                            ([name]) =>
                                OWNERS.includes(message.author.id) || COMMANDS.includes(name)
                        )
                        .map(([name, count]) => `${name}: ${count.toLocaleString()}`)
                        .join('\n')}`
                }
            })
            .catch(err => null);
    } else if (command === '_eval' && OWNERS.includes(message.author.id)) {
        client.commandStats['_eval']++;
        const hide = (str, thing) => str.replaceAll(thing, '-- NOPE --');
        let result, type, length;
        try {
            result = await eval(message.content.slice(PREFIX.length + '_eval'.length).trim());
            type = typeof result;
            if (typeof result !== 'string') result = require('util').inspect(result);
            result = hide(result, client.token);
            length = result.length;
            if (result.length > 4080)
                result = await require('superagent')
                    .post(`https://haste.unbelievaboat.com/documents`)
                    .send(result)
                    .then(res => `https://haste.unbelievaboat.com/${res.body.key}.js`);
            else result = '```js\n' + result + '\n```';
        } catch (err) {
            type = 'error';
            result = '```js\n' + require('util').inspect(err).slice(0, 4070) + '\n```';
            length = 'unknown';
        }
        // @ts-ignore
        await client.api.channels[message.channelId].messages
            .post({
                data: {
                    embeds: [
                        {
                            title: type,
                            description: result,
                            color: 0x039dfc,
                            footer: {
                                text: `length: ${length}`
                            },
                            timestamp: new Date()
                        }
                    ]
                }
            })
            .catch(err => null);
    }
    if (!COMMANDS.includes(command.toLowerCase()) && !mentioned) return;
    client.commandStats[mentioned ? 'mentioned' : command.toLowerCase()]++;
    client.rollingStats.current++;

    // @ts-ignore
    await client.api.channels[message.channelId].messages
        .post({
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
                            }),
                            new MessageButton({
                                url: 'https://discord.gg/mwKZq2y',
                                style: 'LINK',
                                label: 'Support Server'
                            })
                        )
                        .toJSON()
                ]
            }
        })
        .catch(err => null);
});

client.on('ready', () => {
    console.log(` -- [CLUSTER ONLINE] ${client.clusterId}`);
});
client.on('shardReady', id => {
    console.log(` -- [SHARD READY] ${id}`);
});
client.on('invalidRequestWarning', ({ count, remainingTime }) => {
    console.warn(
        ` -- [INVALID REQUESTS] ${count} used with ${Math.ceil(remainingTime / 1000)} seconds left`
    );
});

client.on('raw', async data => {
    if (!['GUILD_CREATE', 'GUILD_DELETE'].includes(data.t)) return;
    if (data.t === 'GUILD_CREATE') client.guildList.add(data.d.id);
    if (data.t === 'GUILD_DELETE') client.guildList.delete(data.d.id);
});

// @ts-ignore
client.ws.createShards = async function createShards() {
    // If we don't have any shards to handle, return
    // @ts-ignore
    if (!this.shardQueue.size) return false;

    // @ts-ignore
    const [shard] = this.shardQueue;

    // @ts-ignore
    this.shardQueue.delete(shard);

    if (!shard.eventsAttached) {
        // @ts-ignore
        shard.on(ShardEvents.ALL_READY, unavailableGuilds => {
            /**
             * Emitted when a shard turns ready.
             * @event Client#shardReady
             * @param {number} id The shard id that turned ready
             * @param {?Set<import('discord.js').Snowflake>} unavailableGuilds Set of unavailable guild ids, if any
             */
            // @ts-ignore
            this.client.emit(Events.SHARD_READY, shard.id, unavailableGuilds);

            // @ts-ignore
            if (!this.shardQueue.size) this.reconnecting = false;
            // @ts-ignore
            this.checkShardsReady();
        });

        shard.on(ShardEvents.CLOSE, event => {
            if (
                event.code === 1_000
                    ? // @ts-ignore
                      this.destroyed
                    : UNRECOVERABLE_CLOSE_CODES.includes(event.code)
            ) {
                /**
                 * Emitted when a shard's WebSocket disconnects and will no longer reconnect.
                 * @event Client#shardDisconnect
                 * @param {CloseEvent} event The WebSocket close event
                 * @param {number} id The shard id that disconnected
                 */
                // @ts-ignore
                this.client.emit(Events.SHARD_DISCONNECT, event, shard.id);
                // @ts-ignore
                this.debug(WSCodes[event.code], shard);
                return;
            }

            if (UNRESUMABLE_CLOSE_CODES.includes(event.code)) {
                // These event codes cannot be resumed
                shard.sessionId = null;
            }

            /**
             * Emitted when a shard is attempting to reconnect or re-identify.
             * @event Client#shardReconnecting
             * @param {number} id The shard id that is attempting to reconnect
             */
            // @ts-ignore
            this.client.emit(Events.SHARD_RECONNECTING, shard.id);

            // @ts-ignore
            this.shardQueue.add(shard);

            if (shard.sessionId) {
                // @ts-ignore
                this.debug(`Session id is present, attempting an immediate reconnect...`, shard);
                // @ts-ignore
                this.reconnect();
            } else {
                shard.destroy({ reset: true, emit: false, log: false });
                // @ts-ignore
                this.reconnect();
            }
        });

        shard.on(ShardEvents.INVALID_SESSION, () => {
            // @ts-ignore
            this.client.emit(Events.SHARD_RECONNECTING, shard.id);
        });

        shard.on(ShardEvents.DESTROYED, () => {
            // @ts-ignore
            this.debug(
                'Shard was destroyed but no WebSocket connection was present! Reconnecting...',
                shard
            );

            // @ts-ignore
            this.client.emit(Events.SHARD_RECONNECTING, shard.id);

            // @ts-ignore
            this.shardQueue.add(shard);
            // @ts-ignore
            this.reconnect();
        });

        shard.eventsAttached = true;
    }

    // @ts-ignore
    this.shards.set(shard.id, shard);

    shard.connect().catch(error => {
        if (error?.code && UNRECOVERABLE_CLOSE_CODES.includes(error.code)) {
            throw new Error(WSCodes[error.code]);
            // Undefined if session is invalid, error event for regular closes
        } else if (!error || error.code) {
            // @ts-ignore
            this.debug('Failed to connect to the gateway, requeueing...', shard);
            // @ts-ignore
            this.shardQueue.add(shard);
            // @ts-ignore
            return this.createShards();
        } else {
            throw error;
        }
    });

    // If we have more shards, add a 5s delay
    // @ts-ignore
    if (this.shardQueue.size) {
        // @ts-ignore
        this.debug(`Shard Queue Size: ${this.shardQueue.size}; continuing in 5 seconds...`);
        //await Util.delayFor(5_000);
        // @ts-ignore
        return this.createShards();
    }

    return true;
};

async function postTopgg() {
    const guildCounts = await client.ipc.broadcastEval('this.guildList.size');
    const shard_count = await client.ipc.masterEval('this.totalShards');

    await require('superagent')
        .post('https://top.gg/api/bots/692045914436796436/stats')
        .set('Authorization', TOPGG_KEY)
        .send({ shard_count, server_count: guildCounts.reduce((a, c) => a + c, 0) })
        .catch(console.error);
}
