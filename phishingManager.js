module.exports = class PhishingManager {
    constructor(client) {
        this.client = client;

        this.domainRegex = /([-a-zA-Z0-9._-]{2,256}\.[a-z]{2,10})(?:\/(\S*))?\b/g;
        this.domains = new Set();

        this.fetchInterval = 1000 * 60 * 15;
    }

    async run() {
        this.client.on('raw', async data => {
            if (data.t !== 'MESSAGE_CREATE') return;
            this.test(data.d.content);
        });

        await this.fetchDomains();

        setInterval(() => {
            this.fetchDomains();
        }, this.fetchInterval);

        console.log('  -- [PHISHING MANAGER RUNNING]');
    }

    test(msg) {
        const domains = Array.from(msg.matchAll(this.domainRegex)).filter(
            (d, i, self) => i === self.findIndex(a => a[0] === d[0])
        );

        const hasMatch = domains.filter(d => this.domains.has(d[1]));

        if (hasMatch.length) {
            const matches = hasMatch.map(m => m[1]);
            for (const match of matches) {
                if (!this.client.domainHits[match]) this.client.domainHits[match] = 0;
                this.client.domainHits[match]++;
            }
        }
    }

    async fetchDomains() {
        const fetchDomains = await require('superagent')
            .get(process.env.PHISH_API)
            .send()
            .catch(_ => null);
        if (!fetchDomains || !Array.isArray(fetchDomains.body)) return;
        this.domains = new Set(fetchDomains.body);
    }
};
