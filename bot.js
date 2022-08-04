const {
    Client,
    LimitedCollection,
    Message,
    Constants: { ShardEvents, WSCodes, Events }
} = require('discord.js');
const { RPCErrorCodes } = require('discord-api-types/v9');
const express = require('express');
const { register } = require('prom-client');
const UNRECOVERABLE_CLOSE_CODES = Object.keys(WSCodes).slice(1).map(Number);
const UNRESUMABLE_CLOSE_CODES = [
    RPCErrorCodes.UnknownError,
    RPCErrorCodes.InvalidPermissions,
    RPCErrorCodes.InvalidClientId
];
const IPC = require('./IPC.js');
const Metrics = require('./Metrics');
const PhishingManager = require('./phishingManager.js');
const { TOPGG_KEY, API_URL } = process.env;
const OWNERS = process.env.OWNERS?.split(',') || [];

class TOD extends Client {
    constructor() {
        super({
            intents: ['GUILDS', 'GUILD_MESSAGES'],
            makeCache: () => new LimitedCollection({ maxSize: 0 }),
            presence: { activities: [{ name: 'Truth or Dare • /help', type: 'PLAYING' }] },
            invalidRequestWarningInterval: 250,
            http: { api: API_URL || undefined }
        });
        this.ipc = new IPC(this);
        this.metrics = new Metrics(this);
        this.phishingManager = new PhishingManager(this);
        this.commandStats = {
            'memory--stats': 0,
            'guild--count': 0,
            'shard--guilds': 0,
            'cluster--status': 0,
            'command--stats': 0,
            say: 0,
            eval: 0
        };
        this.websocketEvents = {};
        this.domainHits = {};

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
        /** @type {Set<string>[]} */
        this.guildList = Array.from({ length: this.options.shards.length }, () => new Set());
        console.log(` -- [CLUSTER START] ${this.clusterId}`);

        this.phishingManager.run();

        if (this.clusterId === 1) {
            startWebServer();
            setInterval(postTopgg, 30 * 60 * 1000);
            setInterval(updateMetrics, 60 * 1000);
        }

        return this.login();
    }

    shardCalculator(guildId) {
        let shard = Math.floor(guildId / 2 ** 22) % this.options.shardCount;
        return shard - this.options.shards[0];
    }
}

module.exports = TOD;

const client = new TOD();

client.on('raw', async data => {
    if (data.t !== 'MESSAGE_CREATE') return;
    const message = new Message(client, data.d);
    if (message.author.bot) return;

    const mentioned = message.content.match(new RegExp(`^<@!?${client.user.id}>`))?.[0] ?? '';

    if (!mentioned) return;

    const command = message.content
        .slice(mentioned.length)
        .trim()
        .split(' ')[0]
        .replace(/[—–]/g, '--');
    const rest = message.content.slice(mentioned.length).trim().split(' ').slice(1).join(' ');

    switch (command) {
        case 'memory--stats': {
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
                .catch(_ => null);
            break;
        }
        case 'guild--count': {
            const guildCounts = await client.ipc.broadcastEval(
                'this.guildList.reduce((a, c) => a + c.size, 0)'
            );
            // @ts-ignore
            await client.api.channels[message.channelId].messages
                .post({
                    data: {
                        content: `This cluster: ${client.guildList
                            .reduce((a, c) => a + c.size, 0)
                            .toLocaleString()}\nTotal Guilds: ${guildCounts
                            .reduce((a, c) => a + c, 0)
                            .toLocaleString()}`
                    }
                })
                .catch(_ => null);
            break;
        }
        case 'shard--guilds': {
            const guildCounts = (
                await client.ipc.broadcastEval('this.guildList.map(s => s.size)')
            ).flat();
            const link = await require('superagent')
                .post(`https://haste.unbelievaboat.com/documents`)
                .send(
                    guildCounts.map((c, i) => `${i.toString().padStart(4, ' ')}\t${c}`).join('\n')
                )
                .then(res => `https://haste.unbelievaboat.com/${res.body.key}`);
            // @ts-ignore
            await client.api.channels[message.channelId].messages
                .post({ data: { content: `${Math.max(...guildCounts)}\n${link}` } })
                .catch(_ => null);
            break;
        }
        case 'cluster--status': {
            const clusters = await client.ipc.broadcastEval(
                'this.isReady() ? "online" : "offline"'
            );
            // @ts-ignore
            await client.api.channels[message.channelId].messages
                .post({
                    data: {
                        content:
                            '```js\n' +
                            require('util').inspect(
                                Object.fromEntries(
                                    [...clusters.entries()].map(([a, b]) => [a + 1, b])
                                )
                            ) +
                            '\n```'
                    }
                })
                .catch(_ => null);
            break;
        }
        case 'command--stats': {
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
                Object.fromEntries(
                    Object.entries(c).map(([name, count]) => [name, c1[name] + count])
                )
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
                            .map(([name, count]) => `${name}: ${count.toLocaleString()}`)
                            .join('\n')}`
                    }
                })
                .catch(_ => null);
            break;
        }
        case 'say': {
            if (!OWNERS.includes(message.author.id)) break;
            let [_, channel = message.channelId, mess = ''] =
                rest.match(/(?:(?:<#)?(\d+)>?\s+)?((?:.|\s)+)/i) ?? [];
            // @ts-ignore
            const res = await client.api.channels[channel].messages
                .post({ data: { content: mess } })
                .then(_ => true)
                .catch(_ => false);
            if (!res) {
                // @ts-ignore
                await client.api.channels[message.channelId].messages
                    .post({ data: { content: ':x: failed to send' } })
                    .catch(_ => null);
            }
            break;
        }
        case 'eval': {
            if (!OWNERS.includes(message.author.id)) break;
            const hide = (str, thing) => str.replaceAll(thing, '-- NOPE --');
            let result, type, length;
            try {
                result = await eval(rest);
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
                .catch(_ => null);
            break;
        }
        default: {
            return;
        }
    }
    client.commandStats[command.toLowerCase()]++;
    client.rollingStats.current++;
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

client.on('raw', data => {
    if (!['GUILD_CREATE', 'GUILD_DELETE'].includes(data.t)) return;
    if (data.t === 'GUILD_CREATE')
        client.guildList[client.shardCalculator(data.d.id)].add(data.d.id);
    if (data.t === 'GUILD_DELETE')
        client.guildList[client.shardCalculator(data.d.id)].delete(data.d.id);
});

client.on('raw', data => {
    if (!data.t) return;
    if (!client.websocketEvents[data.t]) client.websocketEvents[data.t] = 0;
    client.websocketEvents[data.t]++;
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

    try {
        await shard.connect();
    } catch (error) {
        if (error?.code && UNRECOVERABLE_CLOSE_CODES.includes(error.code)) {
            throw new Error(WSCodes[error.code]);
            // Undefined if session is invalid, error event for regular closes
        } else if (!error || error.code) {
            // @ts-ignore
            this.debug('Failed to connect to the gateway, requeueing...', shard);
            // @ts-ignore
            this.shardQueue.add(shard);
        } else {
            throw error;
        }
    }
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

function startWebServer() {
    const app = express();
    app.get('/metrics', async (req, res) => {
        if (req.headers.authorization?.replace('Bearer ', '') !== process.env.PROMETHEUS_AUTH)
            return res.sendStatus(401);
        const metrics = await register.metrics();
        res.send(metrics);
    });
    app.listen(3000, () => console.log('  -- [METRICS SERVER ONLINE]'));
}

async function postTopgg() {
    const guildCounts = await client.ipc.broadcastEval(
        'this.guildList.reduce((a, c) => a + c.size, 0)'
    );
    const shard_count = await client.ipc.masterEval('this.totalShards');

    await require('superagent')
        .post('https://top.gg/api/bots/692045914436796436/stats')
        .set('Authorization', TOPGG_KEY)
        .send({ shard_count, server_count: guildCounts.reduce((a, c) => a + c, 0) })
        .catch(console.error);
}

async function updateMetrics() {
    const checkClustersOnline = await client.ipc.broadcastEval('this.isReady()');
    if (checkClustersOnline.some(s => !s)) return; // If all clusters aren't ready yet

    // Server Count
    const guildCounts = await client.ipc.broadcastEval(
        'this.guildList.reduce((a, c) => a + c.size, 0)'
    );
    const guildCount = guildCounts.reduce((a, c) => a + c, 0);

    client.metrics.guildCount.set(guildCount);

    // Command Usage
    const commandStatsArray = await client.ipc.broadcastEval('this.commandStats');
    const commandStats = commandStatsArray.reduce((c, c1) =>
        Object.fromEntries(Object.entries(c).map(([name, count]) => [name, c1[name] + count]))
    );

    client.metrics.updateCommandUse(commandStats);

    // Websocket Events
    const websocketEventsArray = await client.ipc.broadcastEval('this.websocketEvents');
    const websocketEvents = websocketEventsArray.reduce((e, e1) =>
        Object.fromEntries(
            [...Object.keys(e), ...Object.keys(e1)]
                .filter((a, i, r) => r.indexOf(a) === i)
                .map(type => [type, (e[type] ?? 0) + (e1[type] ?? 0)])
        )
    );

    client.metrics.updateWebsocketEvents(websocketEvents);

    // Phishing Domain Hits
    const phishingDomainArray = await client.ipc.broadcastEval('this.domainHits');
    const phishingDomains = phishingDomainArray.reduce((e, e1) =>
        Object.fromEntries(
            [...Object.keys(e), ...Object.keys(e1)]
                .filter((a, i, r) => r.indexOf(a) === i)
                .map(domain => [domain, (e[domain] ?? 0) + (e1[domain] ?? 0)])
        )
    );

    client.metrics.updateDomainHits(phishingDomains);
}
