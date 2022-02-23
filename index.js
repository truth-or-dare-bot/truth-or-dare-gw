require('dotenv').config();
const ClusterManager = require('./ClusterManager');

const manager = new ClusterManager('./bot.js', {
    token: process.env.DISCORD_TOKEN,
    shardsPerCluster: Number(process.env.SHARDS_PER_CLUSTER) || 16,
    totalShards: Number(process.env.TOTAL_SHARDS) || 'auto'
});

manager.run();
