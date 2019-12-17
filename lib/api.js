const stats = require("./stats");

class Api {
    constructor(options) {
        this.options = options;
        this.liveStatConnections = {};
        this.stats = new stats(options);     
    }

    handleApiRequest(req, res, next){
        switch(req.params.method){
        case "stats":
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(this.stats.statsString);
            return;
        case "pool_stats":
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(this.stats.statPoolHistory));
            return;
        case "live_stats":
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });
            res.write("\n");
            var uid = Math.random().toString();
            this.liveStatConnections[uid] = res;
            req.on("close", function() {
                delete this.liveStatConnections[uid];
            });

            return;
        default:
            next();
        }
    }

    handleAdminApiRequest(req, res, next){
        switch(req.params.method){
        case "pools": {
            res.end(JSON.stringify({result: this.options}));
            return;
        }
        default:
            next();
        }
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
        this.poolObj.on("share", function (isValidShare, isValidBlock, shareData) {
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

module.export = {
    Api: Api,
    Worker: Worker,
};
