const { Client, LimitedCollection, Message } = require('discord.js');
const express = require('express');
const { register } = require('prom-client');

const IPC = require('./IPC.js');
const Metrics = require('./Metrics');
/** @type {{TOPGG_KEY: string, API_URL: string}} */
// @ts-ignore
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
        this.commandStats = {
            'memory--stats': 0,
            'guild--count': 0,
            'shard--guilds': 0,
            'cluster--status': 0,
            'command--stats': 0,
            say: 0,
            eval: 0,
            restart: 0
        };
        this.websocketEvents = {};
        this.domainHits = {};

        /** @type {{current: number, past: number[], lastUpdate: number}} */
        this.rollingStats = {
            current: 0,
            past: [],
            lastUpdate: Date.now()
        };
        this.guildList = [];
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

        if (this.clusterId === 1) {
            startWebServer();
            setInterval(postTopgg, 30 * 60 * 1000);
            setInterval(updateMetrics, 60 * 1000);
        }

        return this.login();
    }

    shardCalculator(guildId) {
        // @ts-ignore
        let shard = Math.floor(guildId / 2 ** 22) % this.options.shardCount;
        // @ts-ignore
        return shard - this.options.shards[0];
    }
}

module.exports = TOD;

const client = new TOD();

client.on('raw', async data => {
    if (data.t !== 'MESSAGE_CREATE') return;
    const message = new Message(client, data.d);
    if (message.author.bot) return;

    // @ts-ignore
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
        case 'restart': {
            if (!OWNERS.includes(message.author.id)) break;
            /** @type {string} */
            let result;
            if (rest === 'all') {
                result = await client.ipc.restartAll(message.author.id);
            } else if (rest.includes(':')) {
                const [min, max] = rest.split(':');
                /** @type {[number, number]} */
                const target = [parseInt(min, 10), parseInt(max, 10)];
                result = await client.ipc.restartClusters(target, message.author.id);
            } else {
                result = await client.ipc.restartCluster(parseInt(rest, 10), message.author.id);
            }
            // @ts-ignore
            await client.api.channels[message.channelId].messages
                .post({
                    data: {
                        content: result
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
client.on('shardDisconnect', (e, id) => {
    console.log(` -- [SHARD DISCONNECT] ${id} ${e.code}`);
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
        .catch(err => console.log('[TOPGG POST ERROR]', err.message));
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
}
