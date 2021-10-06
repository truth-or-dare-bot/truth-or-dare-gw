const { EventEmitter } = require('events');

/**
 * @typedef {Object} IncomingMessage
 * @property {string} op - The operation being requested
 * @property {number} cluster - start: The cluster being started
 * @property {[number, number]} shards - start: The shards to start the cluster with
 * @property {number} totalShards - start: The number of shards being run on the entire bot
 * @property {string} [target] - eval: The target of the operation
 * @property {number|[number, number]} [targetID] - eval|restart: The cluster(s) being targeted
 * @property {string} [id] - eval|restart|result: The randomized identifier for the message
 * @property {string} [input] - eval: The code to evaluate
 * @property {any} [output] - result: The result being returned
 */

/**
 * @callback messageOp
 * @param {Object} message - The message received
 */

/**
 * A class to handle inter-process communication
 */
class IPC extends EventEmitter {
    /**
     * Create a IPC manager for a client
     * @param {import('./bot')} client - The client this IPC channel is for
     * @param {Object<string, messageOp>} [messageOps] - Additional functions to handle other message ops
     */
    constructor(client, messageOps = {}) {
        super();

        this.client = client;
        this.messageOps = messageOps;

        process.on('message', this.onMessage.bind(this));
    }

    /**
     * Add a handler for messages from the main process
     * @param {string} op - The operation for the message
     * @param {messageOp} func - The function to call for the op
     */
    addMessageOp(op, func) {
        this[op] = func;
    }

    /**
     * Handle a message from the main process
     * @param {IncomingMessage} message - The message received
     */
    async onMessage(message) {
        switch (message.op) {
            case 'start':
                return this.client.run(message);
            case 'eval':
                return this._eval(message);
            case 'result':
                return this.emit(`result_${message.id}`, message.output);
            case 'restart':
                return process.exit();
            default: {
                if (message.op in this.messageOps) return this.messageOps[message.op](message);
                break;
            }
        }
    }

    /**
     * Process an eval request from the
     * @param {IncomingMessage} message - The message received
     */
    async _eval(message) {
        try {
            const result = await eval.call(this.client, message.input);
            if (message.id) process.send({ op: 'result', id: message.id, output: result });
        } catch (err) {
            if (message.id) process.send({ op: 'result', id: message.id, output: err.stack });
        }
    }

    /**
     * Generate a random string id of alphanumeric characters
     * @returns {string}
     */
    generateID() {
        return Date.now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36);
    }

    /**
     * Make a request to the main process, returns a promise that resolves once the main process responds
     * @param {string} op - The operation to request
     * @param {Object<string, any>} [data={}] - The message to send to the main process
     * @returns {Promise<any>}
     */
    async request(op, data = {}) {
        const id = this.generateID();
        return new Promise(resolve => {
            process.send(Object.assign(data, { op, id }));
            this.once(`result_${id}`, resolve);
        });
    }

    /**
     * Get a list of the clusters currently running on the cluster Manager
     * @returns {Promise<number[]>}
     */
    getClusters() {
        return this.request('clusters');
    }

    /**
     * Execute code on all clusters the cluster manager is running
     * @param {string} input - The code to execute
     * @returns {Promise<any[]>}
     */
    broadcastEval(input) {
        return this.request('eval', { target: 'all', input });
    }

    /**
     * Execute code on the main process
     * @param {string} input - The code to execute
     * @returns {Promise<any>}
     */
    masterEval(input) {
        return this.request('eval', { target: 'master', input });
    }

    /**
     * Execute code on a specific cluster
     * @param {string} input - The code to execute
     * @param {number} targetID - The cluster to run the code on
     * @returns {Promise<any>}
     */
    clusterEval(input, targetID) {
        return this.request('eval', { target: 'cluster', targetID, input });
    }

    /**
     * Execute code on a range of clusters
     * @param {string} input - The code to execute
     * @param {[number, number]} targetID - The range of clusters to run the code on
     * @returns {Promise<any[]>}
     */
    clustersEval(input, targetID) {
        return this.request('eval', { target: 'clusters', targetID, input });
    }

    /**
     * Restart all clusters
     * @param {string} user - The id of the user responsible
     * @returns {Promise<string>}
     */
    async restartAll(user) {
        const res = await this.request('restart', { target: 'all', user });
        if (res.includes('restarting')) return res;
        else throw new Error(res);
    }

    /**
     * Restart a single cluster
     * @param {number} targetID - The cluster to restart
     * @param {string} user - The id of the user responsible
     * @returns {Promise<string>}
     */
    async restartCluster(targetID, user) {
        const res = await this.request('restart', { target: 'cluster', targetID, user });
        if (res.includes('restarting')) return res;
        else throw new Error(res);
    }

    /**
     * Restart a range of clusters
     * @param {[number, number]} targetID - The range of clusters to restart
     * @param {string} user - The id of the user responsible
     * @returns {Promise<string>}
     */
    async restartClusters(targetID, user) {
        const res = await this.request('restart', { target: 'clusters', targetID, user });
        if (res.includes('restarting')) return res;
        else throw new Error(res);
    }

    /**
     * Get the total memory usage of all clusters and the main process
     * @returns {Promise<Object>}
     */
    async memoryUsage() {
        const master = await this.masterEval('process.memoryUsage()');
        const clusters = await this.broadcastEval('process.memoryUsage()');
        clusters.push(master);
        return clusters.reduce((a, c) => {
            Object.keys(c).forEach(k => (a[k] = (a[k] || 0) + c[k]));
            return a;
        }, {});
    }

    get [Symbol.toStringTag]() {
        return this.constructor.name;
    }
}

module.exports = IPC;
