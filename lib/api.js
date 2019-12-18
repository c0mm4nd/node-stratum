const stats = require("./stats");

class Api {
    constructor(options) {
        this.options = options;
        this.liveStatConnections = {};
        this.stats = new stats(options);     
    }

    handleApiRequest(expressApp){
        expressApp.get("/stats", (req, res) => {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            });
            res.end(this.stats.statsString);
            return;
        });

        expressApp.get("/pool_stats", (req, res) => {
            res.writeHead(200, { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            });
            res.end(JSON.stringify(this.stats.statPoolHistory));
            return;
        });

        expressApp.get("/live_stats", (req, res) => {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*"
            });
            res.write("\n");
            var uid = Math.random().toString();
            this.liveStatConnections[uid] = res;
            req.on("close", () => {delete this.liveStatConnections[uid]; });

            return;
        });
    }

    handleAdminApiRequest(expressApp){
        expressApp.get("/admin", (req, res) => {
            res.end(JSON.stringify({result: this.options}));
            return;
        });
    }
}

class Worker {
    constructor(expressApp) {
        this.counters = {
            validShares: 0,
            validBlocks: 0,
            invalidShares: 0
        };

        this.lastEvents = {
            lastValidShare: 0,
            lastValidBlock: 0,
            lastInvalidShare: 0
        };

        this.lastShare = {};

        expressApp.get("/stats", (req, res) => {
            res.send({
                "clients": Object.keys(this.poolObj.stratumServer.getStratumClients()).length,
                "counters": this.counters,
                "last_events": this.lastEvents,
                "last_share": this.lastShare
            });
        });
    }

    start(poolObj) {
        this.poolObj = poolObj;
        this.poolObj.on("share", (isValidShare, isValidBlock, shareData) => {
            let now = Date.now();
            if (isValidShare) {
                this.counters.validShares++;
                this.lastEvents.lastValidShare = now;
                if (isValidBlock) {
                    this.counters.validBlocks++;
                    this.lastEvents.lastValidBlock = now;
                }
            } else {
                this.counters.invalidShares++;
                this.lastEvents.lastInvalidShare = now;
            }

            this.lastShare = shareData;
        });
    }
}

module.export = {Api, Worker};
