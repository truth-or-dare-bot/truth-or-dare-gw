require('dotenv').config();
const ClusterManager = require('./ClusterManager');

const manager = new ClusterManager('./bot.js', {
    token: process.env.DISCORD_TOKEN,
    shardsPerCluster: Number(process.env.SHARDS_PER_CLUSTER) || undefined,
    totalShards: Number(process.env.TOTAL_SHARDS) || 'auto',
    maxConcurrent: Number(process.env.MAX_CONCURRENT) || undefined,
    startDelay: Number(process.env.START_DELAY) || undefined
});

manager.run();
