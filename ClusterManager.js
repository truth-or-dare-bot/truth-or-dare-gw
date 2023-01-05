const superagent = require('superagent');
const sleep = require('util').promisify(setTimeout);

/**
 * @typedef {Object} Cluster
 * @property {number} id - The id of the cluster
 * @property {[number, number]} range - The ids of the first and last shards
 * @property {import('child_process').ChildProcess} child - The child process of the cluster
 * @property {boolean} ready - If the cluster has connected to Discord
 * @property {string} client - The id of the client the cluster is running
 */

/**
 * @typedef {Object} PendingResult
 * @property {any[]} results - The list of results
 * @property {number} offset - The first cluster id - 1
 * @property {number} expected - The number of results expected
 * @property {number} origin - The id of the cluster that asked for the results
 */

/**
 * @typedef {Object} IncomingMessage
 * @property {string} op - The operation being requested
 * @property {string} [client] - ready: The id of the client the cluster is running
 * @property {string} [type] - message: The type of message to log
 * @property {string} [title] - message: The title of the message to log
 * @property {string} [description] - message: The description of the message to log
 * @property {number} [color] - message: The color to use for the message logging
 * @property {string} [footer] - message: The footer note for message to log
 * @property {string} [target] - eval|restart: The target of the operation
 * @property {number|[number, number]} [targetID] - eval|restart: The cluster(s) being targeted
 * @property {string} [id] - eval|restart|result|clusters: The randomized identifier for the message
 * @property {string} [input] - eval: The code to evaluate
 * @property {any} [output] - result: The result being returned
 * @property {string} [user] - restart: The user requesting the restart
 */

/**
 * @callback messageOp
 * @param {Cluster} cluster - The cluster sending the message
 * @param {Object} message - The message received
 */

/**
 * @typedef {Object} LogEmbed
 * @property {string} title - The title of the log
 * @property {string} description - The description of the log
 * @property {number} color - The color associated with the log
 * @property {Object} footer - The footer of the log
 * @property {string} footer.text - The footer text of the log
 * @property {Date} timestamp - The timestamp of when the log happened
 */

/**
 * @callback logFunc
 * @param {string} type - The type of log
 * @param {LogEmbed} data - The data being logged
 */

/**
 * A class that manages spawning worker processes for clusters
 */
class ClusterManager {
    /**
     * Create a cluster manager to manage multiple clusters of the bot
     * @param {string} file - The file to have each cluster run
     * @param {Object} [options] - The options to create the manager with
     * @param {string} [options.token] - The bot token for calculating shards automatically
     * @param {'auto'|number} [options.totalShards='auto'] - The total number of shards running for this bot
     * @param {'auto'|[number, number]} [options.shards='auto'] - The range of shards to run, inclusive
     * @param {'auto'|number} [options.firstClusterID='auto'] - The id of the first cluster this manager runs
     * @param {number} [options.shardsPerCluster=1] - The number of shards each cluster manages
     * @param {number} [options.startDelay=10000] - The milliseconds of delay between each cluster starting
     * @param {number} [options.maxConcurrent=5] - The maximumum clusters starting at once
     * @param {boolean} [options.respawn=true] - If clusters should automatically be restarted when the exit
     * @param {Record<string, string>} [options.env] - The environment variables to provide the clusters' process
     * @param {logFunc} [options.logFunction] - The function used to log data, should take two arguments
     * @param {Record<string, messageOp>} [options.messageOps={}] - Any additional message ops
     */
    constructor(file, options = {}) {
        if (!file) throw new Error('The file argument is required');
        if (!require('path').isAbsolute(file)) file = require('path').resolve(process.cwd(), file);
        if (!require('fs').statSync(file).isFile())
            throw new Error('The file argument must be a file');
        this.file = file;

        /** @type {Map<number, Cluster>} */
        this.clusters = new Map();
        /** @type {Map<string, PendingResult>} */
        this.pendingOutputs = new Map();
        /** @type {Set<number>} */
        this.starting = new Set();
        /** @type {Set<{id: number, shards: [number, number]}>} */
        this.clusterQueue = new Set();
        /** @type {boolean} */
        this.spawning = false;

        const {
            token = '',
            totalShards = 'auto',
            shards = 'auto',
            firstClusterID = 'auto',
            shardsPerCluster = 1,
            startDelay = 10000,
            maxConcurrent = 5,
            respawn = true,
            env = process.env,
            logFunction = console.log,
            messageOps = {}
        } = options;

        if (!token && totalShards === 'auto')
            throw new Error('Cannot automatically calculate shards without the token');
        /** @type {string} */
        this.token = token ? token.replace(/Bot */, '') : token;

        /** @type {number | 'auto'} */
        this.totalShards = totalShards;
        if (this.totalShards !== 'auto') {
            if (typeof this.totalShards !== 'number' || isNaN(this.totalShards))
                throw new TypeError('Invalid totalShards option');
            if (this.totalShards < 1 || !Number.isInteger(this.totalShards))
                throw new RangeError('Invalid totalShards, must be a positive integer');
        }

        /** @type {'auto' | [number, number]} */
        this.shards = shards;
        if (shards !== 'auto') {
            if (!Array.isArray(this.shards)) throw new TypeError('Invalid shards range');
            if (this.shards.length !== 2) throw new RangeError('Shard range must have 2 elements');
            if (
                this.shards.some(
                    id => typeof id !== 'number' || isNaN(id) || !Number.isInteger(id) || id < 0
                )
            )
                throw new TypeError('Invalid Shards range, must be an array of positive integers');
        }

        /** @type {number | 'auto'} */
        this.firstClusterID = firstClusterID;
        if (firstClusterID !== 'auto') {
            if (typeof firstClusterID !== 'number' || isNaN(firstClusterID))
                throw new TypeError('Invalid firstClusterID option');
            if (!Number.isInteger(firstClusterID) || firstClusterID < 0)
                throw new RangeError('Invalid firstClusterID option, must be a positive integer');
        }

        if (typeof shardsPerCluster !== 'number' || isNaN(shardsPerCluster))
            throw new TypeError('Invalid shardsPerCluster option');
        if (!Number.isInteger(shardsPerCluster) || shardsPerCluster < 1)
            throw new RangeError('Invalid shardsPerCluster option, must be a positive integer');
        /** @type {number} */
        this.shardsPerCluster = shardsPerCluster;

        if (typeof startDelay !== 'number' || isNaN(startDelay))
            throw new TypeError('Invalid startDelay option');
        if (!Number.isInteger(startDelay) || startDelay < 0)
            throw new RangeError('Invalid startDelay option, must be a positive integer');
        /** @type {number} */
        this.startDelay = startDelay;

        if (typeof maxConcurrent !== 'number' || isNaN(maxConcurrent))
            throw new TypeError('Invalid maxConcurrent option');
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
            throw new RangeError('Invalid maxConcurrent option, must be a positive integer');
        /** @type {number} */
        this.maxConcurrent = maxConcurrent;

        /** @type {boolean} */
        this.respawn = !!respawn;
        /** @type {Record<string, string | undefined>} */
        this.env = env;
        /** @type {logFunc} */
        this.logFunction = logFunction;
        /** @type {Record<string, messageOp>} */
        this.messageOps = messageOps;

        if (this.token && !this.env.DISCORD_TOKEN) this.env.DISCORD_TOKEN = this.token;
    }

    /**
     * Start spawning clusters
     */
    async run() {
        if (this.totalShards === 'auto') this.totalShards = await this.getShards();
        /** @type {[number, number]} */
        const defaultShards = [0, this.totalShards - 1];
        if (this.shards === 'auto') this.shards = defaultShards;
        if (this.firstClusterID === 'auto')
            this.firstClusterID = this.shards[0] / this.shardsPerCluster + 1;

        for (
            let i = 0;
            i <= Math.ceil((this.shards[1] + 1) / this.shardsPerCluster) - this.firstClusterID;
            i++
        ) {
            const firstShard = i * this.shardsPerCluster + this.shards[0];
            const lastShard = Math.min((i + 1) * this.shardsPerCluster - 1, this.shards[1]);

            this.clusterQueue.add({
                id: i + this.firstClusterID,
                shards: [firstShard, lastShard]
            });
        }
        await this.spawnClusters();
    }

    /**
     * Log event data from a cluster
     * @param {string} type - The type of event being logged
     * @param {string} title - The title of the event
     * @param {string} description - The description of the event
     * @param {number} color - The color associated with the event
     * @param {string} footer - The footer text for the event
     */
    log(type, title = '', description = '', color = 0, footer = '\u200b') {
        this.logFunction(type, {
            title,
            description,
            color,
            footer: { text: footer },
            timestamp: new Date()
        });
    }

    /**
     * Fetch the recommended number of shards from discord
     * @returns {Promise<number>}
     */
    getShards() {
        return superagent
            .get('https://discord.com/api/gateway/bot')
            .set('Authorization', 'Bot ' + this.token)
            .then(res => res.body.shards);
    }

    /**
     * Start spawing clusters from the queue
     */
    async spawnClusters() {
        if (this.spawning) return;
        this.spawning = true;
        while (this.clusterQueue.size) {
            if (this.starting.size >= this.maxConcurrent) {
                await sleep(this.startDelay);
                continue;
            }
            const [clust] = this.clusterQueue;
            this.clusterQueue.delete(clust);
            this.starting.add(clust.id);
            await this.spawnCluster(clust.id, clust.shards);
            await sleep(this.startDelay);
        }
        this.spawning = false;
    }

    /**
     * Create a cluster
     * @param {number} id - The cluster id
     * @param {[number, number]} range - The range of shards the cluster will run
     */
    async spawnCluster(id, range) {
        if (this.clusters.has(id)) throw new Error(`Cluster with id of ${id} already exists`);
        const child = require('child_process').fork(this.file, {
            env: Object.assign(
                {
                    SHARD_RANGE: JSON.stringify(range),
                    CLUSTER_ID: id.toString()
                },
                this.env
            )
        });
        await this.handleCluster(id, range, child);
    }

    /**
     * Handle a new cluster after it has been created
     * @param {number} id - The cluster id
     * @param {[number, number]} range - The range of shards it handles
     * @param {import('child_process').ChildProcess} child - The cluster process
     * @returns {Promise<void>}
     */
    async handleCluster(id, range, child) {
        this.clusters.set(id, { id, range, child, ready: false, client: '' });
        child.on('exit', this.onExit.bind(this, id, range));
        child.on('message', this.onMessage.bind(this, this.clusters.get(id)));
        return new Promise(res =>
            child.on('spawn', () => {
                child.send({
                    op: 'start',
                    cluster: id,
                    shards: range,
                    totalShards: this.totalShards
                });
                res();
            })
        );
    }

    /**
     * Handle a cluster exit event
     * @param {number} id - The cluster id
     * @param {[number, number]} range - The range of shards it handles
     * @param {number} code - The exit code
     */
    onExit(id, range, code) {
        this.log(
            'cluster',
            `Cluster Disconnect: ${id}`,
            `Cluster \`${id}\` offline: Shards \`${range.join('-')}\``,
            15216652
        );
        this.clusters.delete(id);
        if ((this.respawn && code === 0) || code === 1) {
            this.clusterQueue.add({ id, shards: range });
            this.spawnClusters();
        }
    }

    /**
     * Handle a message from a child process
     * @param {Cluster} cluster - The cluster that sent the message
     * @param {IncomingMessage} message - The message from the cluster
     */
    async onMessage(cluster, message) {
        switch (message.op) {
            case 'ready':
                return this.onReady(cluster, message);
            case 'message':
                return this.log(
                    message.type,
                    message.title,
                    message.description,
                    message.color,
                    message.footer
                );
            case 'eval':
                return this.handleEval(cluster, message);
            case 'result':
                return this.handleResult(cluster, message);
            case 'restart':
                return this.handleRestart(cluster, message);
            case 'kill':
                return this.killCluster(cluster, message);
            case 'clusters':
                return cluster.child.send({
                    op: 'result',
                    id: message.id,
                    output: [...this.clusters.keys()]
                });
            default: {
                if (message.op in this.messageOps)
                    return this.messageOps[message.op](cluster, message);
                if (message.id)
                    cluster.child.send({
                        op: 'result',
                        id: message.id,
                        output: 'Invalid message op'
                    });
                break;
            }
        }
    }

    /**
     * Handle a cluster readying
     * @param {Cluster} cluster - The cluster that is ready
     * @param {IncomingMessage} message - The message received
     */
    onReady(cluster, message) {
        const { id, range } = cluster;
        this.log(
            'cluster',
            `Cluster Ready: ${id}`,
            `<@!${message.client}> Cluster \`${id}\` ready: Shards \`${range.join('-')}\``,
            1691939
        );
        cluster.ready = true;
        cluster.client = message.client;

        this.starting.delete(id);
    }

    /**
     * Process an eval request from a cluster
     * @param {Cluster} cluster - The cluster asking for the eval
     * @param {IncomingMessage} message - The message received
     */
    handleEval(cluster, message) {
        if (
            !message.target ||
            typeof message.target !== 'string' ||
            !(message.target + 'Eval' in this)
        )
            return cluster.child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid eval target'
            });
        this[message.target + 'Eval'](cluster, message);
    }

    /**
     * Process an eval request to all clusters
     * @param {Cluster} cluster - The cluster asking for the eval
     * @param {IncomingMessage} message - The message received
     */
    allEval({ id }, message) {
        this.pendingOutputs.set(message.id, {
            results: [],
            offset: Math.min(...this.clusters.keys()),
            expected: this.clusters.size,
            origin: id
        });
        for (const { child } of this.clusters.values()) {
            child.send({ op: 'eval', id: message.id, input: message.input });
        }
    }

    /**
     * Process an eval request to the master process
     * @param {Cluster} cluster - The cluster asking for the eval
     * @param {IncomingMessage} message - The message received
     */
    async masterEval({ child }, message) {
        try {
            const result = await eval(message.input);
            if (message.id) child.send({ op: 'result', id: message.id, output: result });
        } catch (err) {
            if (message.id) child.send({ op: 'result', id: message.id, output: err.stack });
        }
    }

    /**
     * Process an eval request to a single cluster
     * @param {Cluster} cluster - The cluster asking for the eval
     * @param {IncomingMessage} message - The message received
     */
    clusterEval({ id, child }, message) {
        if (typeof message.targetID !== 'number' || !this.clusters.has(message.targetID))
            return child.send({ op: 'result', id: message.id, output: 'Target cluster not found' });
        this.pendingOutputs.set(message.id, {
            results: [],
            expected: 1,
            offset: message.targetID,
            origin: id
        });
        this.clusters
            .get(message.targetID)
            .child.send({ op: 'eval', id: message.id, input: message.input });
    }

    /**
     * Process an eval request to a range of clusters
     * @param {Cluster} cluster - The cluster asking for the eval
     * @param {IncomingMessage} message - The message received
     */
    clustersEval({ id, child }, message) {
        if (!Array.isArray(message.targetID))
            return child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid clusters targetID'
            });

        if (message.targetID.some(n => typeof n !== 'number' || !this.clusters.has(n)))
            return child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid clusters targetID range'
            });

        const [first, last] = message.targetID.sort((a, b) => a - b);
        this.pendingOutputs.set(message.id, {
            results: [],
            offset: first,
            expected: last - first + 1,
            origin: id
        });
        for (let i = first; i <= last; i++) {
            const { child } = this.clusters.get(i);
            child.send({ op: 'eval', id: message.id, input: message.input });
        }
    }

    /**
     * Process a result for an eval from a cluster
     * @param {Cluster} cluster - The cluster returning the result
     * @param {IncomingMessage} message - The message received
     */
    handleResult({ id }, message) {
        const output = this.pendingOutputs.get(message.id);
        if (!output) return;
        output.results[id - output.offset] = message.output;
        for (let i = 0; i < output.expected; i++) if (!(i in output.results)) return;
        this.clusters
            .get(output.origin)
            .child.send({ op: 'result', id: message.id, output: output.results });
        this.pendingOutputs.delete(message.id);
    }

    /**
     * Process a request to restart clusters
     * @param {Cluster} cluster - The cluster requesting a restart
     * @param {IncomingMessage} message - The message received
     */
    handleRestart(cluster, message) {
        if (!message.target || typeof message.target !== 'string')
            return cluster.child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid restart target'
            });
        if (!('restart' + message.target[0].toUpperCase() + message.target.slice(1) in this))
            return cluster.child.send({
                op: 'result',
                id: message.id,
                output: 'Could not find restart handler for the target'
            });
        this['restart' + message.target[0].toUpperCase() + message.target.slice(1)](
            cluster,
            message
        );
    }

    /**
     * Handle a request to restart a single cluster
     * @param {Cluster} cluster - The cluster requesting the restart
     * @param {IncomingMessage} message - The message received
     */
    async restartCluster({ child }, message) {
        if (typeof message.targetID !== 'number' || !this.clusters.has(message.targetID))
            return child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid target ID to restart'
            });

        const cluster = this.clusters.get(message.targetID);
        this.log(
            'cluster',
            `Cluster Restart: ${cluster.id}`,
            `<@!${cluster.client}> Cluster \`${cluster.id}\` restarting. Requested by: <@!${message.user}>`,
            237052
        );
        child.send({
            op: 'result',
            id: message.id,
            output: `Restarting cluster \`${cluster.id}\``
        });

        await sleep(1000);

        cluster.child.send({ op: 'restart' });
    }

    /**
     * Handle a request to restart all clusters
     * @param {Cluster} cluster - The cluster requesting the restart
     * @param {IncomingMessage} message - The message received
     */
    async restartAll({ child, client }, message) {
        this.log(
            'cluster',
            `Full Restart`,
            `<@!${client}> All clusters restarting. Requested by: <@!${message.user}>`,
            237052
        );
        child.send({ op: 'result', id: message.id, output: 'Restarting all clusters' });

        for (const { child } of this.clusters.values()) {
            await sleep(this.startDelay);
            child.send({ op: 'restart' });
        }
    }

    /**
     * Handle a request to restart a range of clusters
     * @param {Cluster} cluster - The cluster requesting the restart
     * @param {IncomingMessage} message - The message received
     */
    async restartClusters({ child, client }, message) {
        if (!Array.isArray(message.targetID) || message.targetID.some(n => !this.clusters.has(n)))
            return child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid targetID clusters to restart'
            });

        this.log(
            'cluster',
            `Clusters Restart: ${message.targetID.join('-')}`,
            `<@!${client}> Cluster \`${message.targetID.join(
                '-'
            )}}\` restarting. Requested by: <@!${message.user}>`,
            237052
        );
        child.send({
            op: 'result',
            id: message.id,
            output: `Restarting clusters ${message.targetID.join('-')}`
        });

        for (let i = message.targetID[0]; i <= message.targetID[1]; i++) {
            await sleep(this.startDelay);
            this.clusters.get(i).child.send({ op: 'restart' });
        }
    }

    /**
     * Kill a cluster and prevent it from re-spawning, requires using spawnCluster manually to revive it, restart is recommended over this method
     * @param {Cluster} cluster - The cluster requesting the kill
     * @param {IncomingMessage} message - The message received
     */
    async killCluster({ child }, message) {
        if (typeof message.targetID !== 'number' || !this.clusters.has(message.targetID))
            return child.send({
                op: 'result',
                id: message.id,
                output: 'Invalid target ID to restart'
            });

        const cluster = this.clusters.get(message.targetID);
        this.log(
            'cluster',
            `Cluster Kill: ${cluster.id}`,
            `<@!${cluster.client}> Cluster \`${cluster.id}\`. Requested by: <@!${message.user}>`,
            15216652
        );
        child.send({ op: 'result', id: message.id, output: `Killing cluster \`${cluster.id}\`` });

        await sleep(1000);

        cluster.child.kill();
    }
}

module.exports = ClusterManager;
