const fs = require("fs");

const redis = require("redis");
const async = require("async");

const DaemonManager = require("./daemonManager");
const utils = require("./utils");


module.exports = class Payment {
    constructor(options, logger) {
        if (logger == undefined) {
            this.logger = console;
        }

        this.coin = options.coin.name;
        this.daemon = new DaemonManager([options.payment.daemon], function (severity, message) {
            logger.log(severity + message);
        });
        this.redisClient = redis.createClient(options.redis.port, options.redis.host, options.redis);

        this.magnitude;
        this.minPaymentSatoshis;
        this.coinPrecision;

        this.paymentInterval;

        this.SetupForPool((setupResult) => {
            logger.log(setupResult);
            // paymentConfig = option.payment;
            // var logSystem = 'Payments';
            // var logComponent = coin;
            //     logger.debug('Payment processing setup to run every '
            //         + processingConfig.paymentInterval + ' second(s) with daemon ('
            //         + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
            //         + ') and redis (' + options.redis.host + ':' + options.redis.port + ')');

        });



    }

    SetupForPool(setupFinished) {
        async.parallel([
            function (callback) {
                this.daemon.cmd("validateaddress", [this.options.address], (result) => {
                    if (result.error) {
                        this.logger.error("Error with payment processing daemon " + JSON.stringify(result.error));
                        callback(true);
                    } else if (!result.response || !result.response.ismine) {
                        this.daemon.cmd("getaddressinfo", [this.options.address], function (result) {
                            if (result.error) {
                                this.logger.error("Error with payment processing daemon, getaddressinfo failed ... " + JSON.stringify(result.error));
                                callback(true);
                            } else if (!result.response || !result.response.ismine) {
                                this.logger.error("Daemon does not own pool address - payment processing can not be done with this daemon, " +
                                    JSON.stringify(result.response));
                                callback(true);
                            } else {
                                callback();
                            }
                        }, true);
                    } else {
                        callback();
                    }
                }, true);
            },
            function (callback) {
                this.daemon.cmd("getbalance", [], (result) => {
                    if (result.error) {
                        callback(true);
                        return;
                    }
                    try {
                        var d = result.data.split("result\":")[1].split(",")[0].split(".")[1];
                        this.magnitude = parseInt("10" + new Array(d.length).join("0"));
                        this.minPaymentSatoshis = parseInt(this.options.payment.minimumPayment * this.magnitude);
                        this.coinPrecision = this.magnitude.toString().length - 1;
                        callback();
                    } catch (e) {
                        this.logger.error("Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: " + result.data);
                        callback(true);
                    }
                }, true, true);
            }
        ], (err) => {
            if (err) {
                setupFinished(false);
                return;
            }
            this.paymentInterval = setInterval(() => {
                this.processPayments();
            }, this.options.payment.paymentInterval * 1000);
            setTimeout(this.processPayments, 100);
            setupFinished(true);
        });

        /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
           when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    }

    satoshisToCoins(satoshis) {
        return parseFloat((satoshis / this.magnitude).toFixed(this.coinPrecision));
    }

    coinsToSatoshies(coins) {
        return coins * this.magnitude;
    }

    getProperAddress(address) {
        if (address.length === 40) {
            return utils.addressFromEx(this.options.address, address);
        } else return address;
    }

    processPayments() {

        let startPaymentProcess = Date.now();

        let timeSpentRPC = 0;
        let timeSpentRedis = 0;

        let startTimeRedis;
        let startTimeRPC;

        var startRedisTimer = function () {
            startTimeRedis = Date.now();
        };
        var endRedisTimer = function () {
            timeSpentRedis += Date.now() - startTimeRedis;
        };

        var startRPCTimer = function () {
            startTimeRPC = Date.now();
        };
        var endRPCTimer = function () {
            timeSpentRPC += Date.now() - startTimeRPC;
        };

        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function (callback) {
                startRedisTimer();
                this.redisClient.multi([
                    ["hgetall", this.coin + ":balances"],
                    ["smembers", this.coin + ":blocksPending"]
                ]).exec(function (error, results) {
                    endRedisTimer();

                    if (error) {
                        this.logger.error("Could not get blocks from redis " + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var workers = {};
                    for (var w in results[0]) {
                        workers[w] = {
                            balance: this.coinsToSatoshies(parseFloat(results[0][w]))
                        };
                    }

                    var rounds = results[1].map(function (r) {
                        var details = r.split(":");
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });

                    callback(null, workers, rounds);
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function (workers, rounds, callback) {

                var batchRPCcommand = rounds.map(function (r) {
                    return ["gettransaction", [r.txHash]];
                });

                batchRPCcommand.push(["getaccount", [this.options.address]]);

                startRPCTimer();
                this.daemon.batchCmd(batchRPCcommand, function (error, txDetails) {
                    endRPCTimer();

                    if (error || !txDetails) {
                        this.logger.error("Check finished - daemon rpc error with batch gettransactions " +
                            JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount;

                    txDetails.forEach(function (tx, i) {

                        if (i === txDetails.length - 1) {
                            addressAccount = tx.result;
                            return;
                        }

                        var round = rounds[i];

                        if (tx.error && tx.error.code === -5) {
                            this.logger.warning("Daemon reports invalid transaction: " + round.txHash);
                            round.category = "kicked";
                            return;
                        } else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)) {
                            this.logger.warning("Daemon reports no details for transaction: " + round.txHash);
                            round.category = "kicked";
                            return;
                        } else if (tx.error || !tx.result) {
                            this.logger.error("Odd error with gettransaction " + round.txHash + " " +
                                JSON.stringify(tx));
                            return;
                        }

                        var generationTx = tx.result.details.filter(function (tx) {
                            return tx.address === this.options.address;
                        })[0];


                        if (!generationTx && tx.result.details.length === 1) {
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx) {
                            this.logger.error("Missing output details to pool address for transaction " + round.txHash);
                            return;
                        }

                        round.category = generationTx.category;
                        if (round.category === "generate") {
                            round.reward = generationTx.amount || generationTx.value;
                        }

                    });

                    var canDeleteShares = function (r) {
                        for (var i = 0; i < rounds.length; i++) {
                            var compareR = rounds[i];
                            if ((compareR.height === r.height) &&
                                (compareR.category !== "kicked") &&
                                (compareR.category !== "orphan") &&
                                (compareR.serialized !== r.serialized)) {
                                return false;
                            }
                        }
                        return true;
                    };


                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function (r) {
                        switch (r.category) {
                        case "orphan":
                        case "kicked":
                            r.canDeleteShares = canDeleteShares(r);
                            break;
                        case "generate":
                            return true;

                        default:
                            return false;
                        }
                    });


                    callback(null, workers, rounds, addressAccount);

                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. */
            function (workers, rounds, addressAccount, callback) {


                var shareLookups = rounds.map(function (r) {
                    return ["hgetall", this.coin + ":shares:round" + r.height];
                });

                startRedisTimer();
                this.redisClient.multi(shareLookups).exec(function (error, allWorkerShares) {
                    endRedisTimer();

                    if (error) {
                        callback("Check finished - redis error with multi get rounds share");
                        return;
                    }


                    rounds.forEach(function (round, i) {
                        var workerShares = allWorkerShares[i];

                        if (!workerShares) {
                            this.logger.error("No worker shares for round: " +
                                round.height + " blockHash: " + round.blockHash);
                            return;
                        }

                        switch (round.category) {
                        case "kicked":
                        case "orphan":
                            round.workerShares = workerShares;
                            break;

                        case "generate":
                            /* We found a confirmed block! Now get the reward for it and calculate how much
                                       we owe each miner based on the shares they submitted during that block round. */
                            var reward = parseInt(round.reward * this.magnitude);

                            var totalShares = Object.keys(workerShares).reduce(function (p, c) {
                                return p + parseFloat(workerShares[c]);
                            }, 0);

                            for (var workerAddress in workerShares) {
                                var percent = parseFloat(workerShares[workerAddress]) / totalShares;
                                var workerRewardTotal = Math.floor(reward * percent);
                                var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                worker.reward = (worker.reward || 0) + workerRewardTotal;
                            }
                            break;
                        }
                    });

                    callback(null, workers, rounds, addressAccount);
                });
            },


            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function (workers, rounds, addressAccount, callback) {

                var trySend = function (withholdPercent) {
                    var addressAmounts = {};
                    var totalSent = 0;
                    for (var w in workers) {
                        var worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        var toSend = (worker.balance + worker.reward) * (1 - withholdPercent);
                        if (toSend >= this.minPaymentSatoshis) {
                            totalSent += toSend;
                            var address = worker.address = (worker.address || this.getProperAddress(w));
                            worker.sent = addressAmounts[address] = this.satoshisToCoins(toSend);
                            worker.balanceChange = Math.min(worker.balance, toSend) * -1;
                        } else {
                            worker.balanceChange = Math.max(toSend - worker.balance, 0);
                            worker.sent = 0;
                        }
                    }

                    if (Object.keys(addressAmounts).length === 0) {
                        callback(null, workers, rounds);
                        return;
                    }

                    this.daemon.cmd("sendmany", [addressAccount || "", addressAmounts], function (result) {
                        //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                        if (result.error && result.error.code === -6) {
                            var higherPercent = withholdPercent + 0.01;
                            this.logger.warning("Not enough funds to cover the tx fees for sending out payments, decreasing rewards by " +
                                (higherPercent * 100) + "% and retrying");
                            trySend(higherPercent);
                        } else if (result.error) {
                            this.logger.error("Error trying to send payments with RPC sendmany " +
                                JSON.stringify(result.error));
                            callback(true);
                        } else {
                            this.logger.debug("Sent out a total of " + (totalSent / this.magnitude) +
                                " to " + Object.keys(addressAmounts).length + " workers");
                            if (withholdPercent > 0) {
                                this.logger.warning("Had to withhold " + (withholdPercent * 100) +
                                    "% of reward from miners to cover transaction fees. " +
                                    "Fund pool wallet with coins to prevent this from happening");
                            }
                            callback(null, workers, rounds);
                        }
                    }, true, true);
                };
                trySend(0);

            },
            function (workers, rounds, callback) {

                var totalPaid = 0;

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                for (var w in workers) {
                    var worker = workers[w];
                    if (worker.balanceChange !== 0) {
                        balanceUpdateCommands.push([ "hincrbyfloat", this.coin + ":balances", w, this.satoshisToCoins(worker.balanceChange)]);
                    }
                    if (worker.sent !== 0) {
                        workerPayoutsCommand.push(["hincrbyfloat", this.coin + ":payouts", w, worker.sent]);
                        totalPaid += worker.sent;
                    }
                }



                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var moveSharesToCurrent = function (r) {
                    var workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanMergeCommands.push(["hincrby", this.coin + ":shares:roundCurrent",
                            worker, workerShares[worker]
                        ]);
                    });
                };

                rounds.forEach(function (r) {

                    switch (r.category) {
                    case "kicked":
                        movePendingCommands.push(["smove", this.coin + ":blocksPending", this.coin + ":blocksKicked", r.serialized]);
                        break;
                    case "orphan":
                        movePendingCommands.push(["smove", this.coin + ":blocksPending", this.coin + ":blocksOrphaned", r.serialized]);
                        if (r.canDeleteShares) {
                            moveSharesToCurrent(r);
                            roundsToDelete.push(this.coin + ":shares:round" + r.height);
                        }
                        return;
                    case "generate":
                        movePendingCommands.push(["smove", this.coin + ":blocksPending", this.coin + ":blocksConfirmed", r.serialized]);
                        roundsToDelete.push(this.coin + ":shares:round" + r.height);
                        return;
                    }

                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(["del"].concat(roundsToDelete));

                if (totalPaid !== 0)
                    finalRedisCommands.push(["hincrbyfloat", this.coin + ":stats", "totalPaid", totalPaid]);

                if (finalRedisCommands.length === 0) {
                    callback();
                    return;
                }

                startRedisTimer();
                this.redisClient.multi(finalRedisCommands).exec(function (error) {
                    endRedisTimer();
                    if (error) {
                        clearInterval(this.paymentInterval);
                        this.logger.error("Payments sent but could not update redis. " + JSON.stringify(error) +
                            " Disabling payment processing to prevent possible double-payouts. The redis commands in " +
                            this.coin + "_finalRedisCommands.txt must be ran manually");
                        fs.writeFile(this.coin + "_finalRedisCommands.txt", JSON.stringify(finalRedisCommands), function (err) {
                            this.logger.error("Could not write finalRedisCommands.txt: ", err);
                        });
                    }

                    callback();
                });
            }
        ], function () {

            var paymentProcessTime = Date.now() - startPaymentProcess;
            this.logger.debug("Finished interval - time spent: " +
                paymentProcessTime + "ms total, " + timeSpentRedis + "ms redis, " +
                timeSpentRPC + "ms daemon RPC");
        });
    }
};