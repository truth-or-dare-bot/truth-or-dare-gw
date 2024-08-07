const { collectDefaultMetrics, Gauge, Registry } = require('prom-client');

class Metrics {
    constructor(client) {
        this.client = client;

        this.guildCount = new Gauge({
            name: 'guild_count',
            help: 'The number of servers the bot is in'
        });

        this.commandsUsed = new Gauge({
            name: 'text_commands_used',
            help: 'The number of temporary text commands used',
            labelNames: ['command']
        });

        this.websocketEvents = new Gauge({
            name: 'websocket_events',
            help: 'The number of websocket events the bot received',
            labelNames: ['type']
        });

        collectDefaultMetrics();
    }

    updateCommandUse(commands) {
        Object.entries(commands).forEach(([command, count]) =>
            this.commandsUsed.labels(command).set(count)
        );
    }

    updateWebsocketEvents(events) {
        Object.entries(events).forEach(([type, count]) =>
            this.websocketEvents.labels(type).set(count)
        );
    }
}

module.exports = Metrics;
