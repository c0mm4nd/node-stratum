const redis = require("redis");
const async = require("async");
const events = require("events");
const {algorithm} = require("./algorithm");

module.export = class Stats extends events.EventEmitter {
    constructor(options, logger){
        super();

        this.logger = logger || function (severity, message) {
            console.log("[" + severity + "]: " + message);
        };

        this.options = options;
        this.redisClients = [];
        this.redisStats;

        this.statHistory = [];
        this.statPoolHistory = [];
        
        this.stats = {};
        this.statsString = "";

        this.setupStatsRedis();
        this.gatherStatHistory();

        this.canDoStats = true;

        if (!this.canDoStats) return;
    
            
        if (options.redis === undefined) {
            return;
        }

        var redisConfig = options.redis;
    
        this.coin = options.coin;

        this.redisClients.push({
            coin: this.coin,
            client: redis.createClient(redisConfig.port, redisConfig.host)
        });
    
    }

    setupStatsRedis() {
        this.redisStats = redis.createClient(this.options.redis.port, this.options.redis.host, this.options.redis);
        this.redisStats.on("error", function(err){
            this.logger("error", "Redis for stats had an error " + JSON.stringify(err));
        });
    }

    gatherStatHistory(){
        var retentionTime = (((Date.now() / 1000) - this.options.api.stats.historicalRetention) | 0).toString();

        this.redisStats.zrangebyscore(["statHistory", retentionTime, "+inf"], (err, replies) => {
            if (err) {
                this.logger("error", "Error when trying to grab historical stats " + JSON.stringify(err));
                return;
            }
            for (var i = 0; i < replies.length; i++){
                this.statHistory.push(JSON.parse(replies[i]));
            }
            this.statHistory = this.statHistory.sort(function(a, b){
                return a.time - b.time;
            });
            this.statHistory.forEach(function(stats){
                this.addStatPoolHistory(stats);
            });
        });
    }

    addStatPoolHistory(stats){
        var data = {
            time: stats.time,
            pools: {}
        };
        for (var pool in stats.pools){
            data.pools[pool] = {
                hashrate: stats.pools[pool].hashrate,
                workerCount: stats.pools[pool].workerCount,
                blocks: stats.pools[pool].blocks
            };
        }
        this.statPoolHistory.push(data);
    }

    getGlobalStats(callback){

        const statGatherTime = Date.now() / 1000 | 0;

        let stats = {};

        async.each(this.redisClients, function(client, callback){
            const windowTime = (((Date.now() / 1000) - this.options.api.stats.hashrateWindow) | 0).toString();
            let redisCommands = [];

            const redisCommandTemplates = [
                ["zremrangebyscore", ":hashrate", "-inf", "(" + windowTime],
                ["zrangebyscore", ":hashrate", windowTime, "+inf"],
                ["hgetall", ":stats"],
                ["scard", ":blocksPending"],
                ["scard", ":blocksConfirmed"],
                ["scard", ":blocksKicked"]
            ];

            redisCommandTemplates.map((t) =>{
                var clonedTemplates = t.slice(0);
                clonedTemplates[1] = this.coin + clonedTemplates[1];
                redisCommands.push(clonedTemplates);
            });

            client.client.multi(redisCommands).exec(function(err, replies){
                if (err){
                    this.logger("error", "error with getting global stats " + JSON.stringify(err));
                    callback(err);
                }
                else{
                    var coinName = client.coin.name;
                    var coinStats = {
                        name: coinName,
                        symbol: this.options.coin.symbol.toUpperCase(),
                        algorithm: this.options.coin.algorithm,
                        hashrates: replies[1],
                        poolStats: {
                            validShares: replies[2] ? (replies[2].validShares || 0) : 0,
                            validBlocks: replies[2] ? (replies[2].validBlocks || 0) : 0,
                            invalidShares: replies[2] ? (replies[2].invalidShares || 0) : 0,
                            totalPaid: replies[2] ? (replies[2].totalPaid || 0) : 0
                        },
                        blocks: {
                            pending: replies[3],
                            confirmed: replies[4],
                            orphaned: replies[5]
                        }
                    };
                    stats = (coinStats);
                    callback();
                }
            });
        }, function(err){
            if (err){
                this.logger("error", "error getting all stats" + JSON.stringify(err));
                callback();
                return;
            }

            let globalStats = {
                time: statGatherTime,
                algo: undefined,
                pool: stats
            };

            // input workers and calc shares 
            stats.hashrates.forEach((ins) => {
                let parts = ins.split(":");
                let workerShares = parseFloat(parts[0]);
                let worker = parts[1];
                if (workerShares > 0) {
                    stats.shares += workerShares;
                    if (worker in stats.workers)
                        stats.workers[worker].shares += workerShares;
                    else
                        stats.workers[worker] = {
                            shares: workerShares,
                            invalidshares: 0,
                            hashrateString: null
                        };
                }
                else {
                    if (worker in stats.workers) {
                        stats.workers[worker].invalidshares -= workerShares; // workerShares is negative number!
                    }
                    else{
                        stats.workers[worker] = {
                            shares: 0,
                            invalidshares: -workerShares,
                            hashrateString: null
                        };
                    }

                }
            });

            var shareMultiplier = Math.pow(2, 32) / algorithm.multiplier;
            stats.hashrate = shareMultiplier * stats.shares / this.portalConfig.api.stats.hashrateWindow;

            stats.workerCount = Object.keys(stats.workers).length;
            globalStats.workers += stats.workerCount;

            for (var worker in stats.workers) {
                stats.workers[worker].hashrateString = this.getReadableHashRateString(shareMultiplier * stats.workers[worker].shares / this.options.api.stats.hashrateWindow);
            }

            // delete stats.hashrates;
            // delete stats.shares;

            this.stats = globalStats;
            this.statsString = JSON.stringify(globalStats);

            this.statHistory.push(globalStats);
            this.addStatPoolHistory(globalStats);

            var retentionTime = (((Date.now() / 1000) - this.options.api.stats.historicalRetention) | 0);

            for (var i = 0; i < this.statHistory.length; i++){
                if (retentionTime < this.statHistory[i].time){
                    if (i > 0) {
                        this.statHistory = this.statHistory.slice(i);
                        this.statPoolHistory = this.statPoolHistory.slice(i);
                    }
                    break;
                }
            }

            this.redisStats.multi([
                ["zadd", "statHistory", statGatherTime, this.statsString],
                ["zremrangebyscore", "statHistory", "-inf", "(" + retentionTime]
            ]).exec(function(err){
                if (err)
                    this.logger("error", "Error adding stats to historics " + JSON.stringify(err));
            });
            callback();
        });

    }

    getReadableHashRateString(hashrate){
        var i = -1;
        var byteUnits = [ " KH", " MH", " GH", " TH", " PH" ];
        do {
            hashrate = hashrate / 1000;
            i++;
        } while (hashrate > 1000);
        return hashrate.toFixed(2) + byteUnits[i];
    }
};