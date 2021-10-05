require('dotenv').config();
const ClusterManager = require('./ClusterManager');

const manager = new ClusterManager('./bot.js', {
    token: process.env.DISCORD_TOKEN,
    shardsPerCluster: 16
});

manager.run();
