module.exports = class Workerapi {
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

