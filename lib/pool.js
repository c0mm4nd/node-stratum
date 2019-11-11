"use strict";
Object.defineProperty(exports, "__esModule", {value: true});
const events_1 = require("events");
const async = require("async");
const varDiff_1 = require("./varDiff");
require("./daemon");
const peer_1 = require("./peer");
require("./stratum");
const jobManager_1 = require("./jobManager");
const util = require("./util");
const algoProperties_1 = require("./algoProperties");
const daemon_1 = require("./daemon");
const stratum_1 = require("./stratum");
class Pool extends events_1.EventEmitter {
    constructor(options, authorizeFn) {
        super();
        this.options = options;
        this.authorizeFn = authorizeFn;
        if (!(options.coin.algorithm in algoProperties_1.algorithms)) {
            this.emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
            throw new Error();
        }
    }
    emitLog(text) {
        this.emit('log', 'debug', text);
    }
    emitWarningLog(text) {
        this.emit('log', 'warning', text);
    }
    emitErrorLog(text) {
        this.emit('log', 'error', text);
    }
    emitSpecialLog(text) {
        this.emit('log', 'special', text);
    }
    start() {
        this.SetupVarDiff();
        this.SetupApi();
        this.SetupDaemonInterface(() => {
            this.DetectCoinData(() => {
                this.SetupRecipients();
                this.SetupJobManager();
                this.OnBlockchainSynced(() => {
                    this.GetFirstJob(() => {
                        this.SetupBlockPolling();
                        this.SetupPeer();
                        this.StartStratumServer(() => {
                            this.OutputPoolInfo();
                            this.emit('started');
                        });
                    });
                });
            });
        });
    }
    ;
    GetFirstJob(finishedCallback) {
        this.GetBlockTemplate((error, result) => {
            if (error) {
                this.emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }
            let portWarnings = [];
            let networkDiffAdjusted = this.options.initStats.difficulty;
            Object.keys(this.options.ports).forEach((port) => {
                let portDiff = this.options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                let warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                this.emitWarningLog(warnMessage);
            }
            finishedCallback();
        });
    }
    OutputPoolInfo() {
        let startMessage = 'Stratum Pool Server Started for ' + this.options.coin.name +
            ' [' + this.options.coin.symbol.toUpperCase() + '] {' + this.options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0') {
            this.emitLog(startMessage);
            return;
        }
        let infoLines = [startMessage,
            'Network Connected:\t' + (this.options.testnet ? 'Testnet' : 'Mainnet'),
            'Detected Reward Type:\t' + this.options.coin.reward,
            'Current Block Height:\t' + this.jobManager.currentJob.rpcData.height,
            'Current Connect Peers:\t' + this.options.initStats.connections,
            'Current Block Diff:\t' + this.jobManager.currentJob.difficulty * algoProperties_1.algorithms[this.options.coin.algorithm].multiplier,
            'Network Difficulty:\t' + this.options.initStats.difficulty,
            'Network Hash Rate:\t' + util.getReadableHashRateString(this.options.initStats.networkHashRate),
            'Stratum Port(s):\t' + this.options.initStats.stratumPorts.join(', '),
            'Pool Fee Percent:\t' + this.options.feePercent + '%'
        ];
        if (typeof this.options.blockRefreshInterval === "number" && this.options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + this.options.blockRefreshInterval + ' ms');
        this.emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }
    OnBlockchainSynced(syncedCallback) {
        const generateProgress = () => {
            const cmd = this.options.coin.hasGetInfo ? 'getinfo' : 'getblockchaininfo';
            this.daemon.cmd(cmd, [], (results) => {
                const blockCount = results.sort((a, b) => {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;
                this.daemon.cmd('getpeerinfo', [], (results) => {
                    let peers = results[0].response;
                    let totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;
                    let percent = (blockCount / totalBlocks * 100).toFixed(2);
                    this.emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                }, false, false);
            }, false, false);
        };
        let checkSynced = (displayNotSynced) => {
            this.daemon.cmd('getblocktemplate', [{
                    "capabilities": ["coinbasetxn", "workid", "coinbase/append"],
                    "rules": ["segwit"]
                }], function (results) {
                let synced = results.every(function (r) {
                    return !r.error || r.error.code !== -10;
                });
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced)
                        displayNotSynced();
                    setTimeout(checkSynced, 5000);
                    if (!process.env.forkId || process.env.forkId === '0')
                        generateProgress();
                }
            }, false, false);
        };
        checkSynced(() => {
            if (!process.env.forkId || process.env.forkId === '0')
                this.emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });
    }
    SetupApi() {
        if (typeof (this.options.api) !== 'object' || typeof (this.options.api.start) !== 'function') {

        }
        else {
            this.options.api.start(this);
        }
    }
    SetupPeer() {
        if (!this.options.p2p || !this.options.p2p.enabled)
            return;
        if (this.options.testnet && !this.options.coin.peerMagicTestnet) {
            this.emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        } else if (!this.options.coin.peerMagic) {
            this.emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }
        this.peer = new peer_1.Peer(this.options);
        this.peer.on('connected', () => {
            this.emitLog('p2p connection successful');
        }).on('connectionRejected', () => {
            this.emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', () => {
            this.emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', (e) => {
            this.emitErrorLog('p2p connection failed - likely incorrect host or port:' + e);
        }).on('socketError', (e) => {
            this.emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', (msg) => {
            this.emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', (hash) => {
            this.processBlockNotify(hash, 'p2p');
        });
    }
    SetupVarDiff() {
        this.varDiff = {};
        Object.keys(this.options.ports).forEach((port) => {
            if (this.options.ports[port].varDiff)
                this.setVarDiff(port, this.options.ports[port].varDiff);
        });
    }
    SubmitBlock(blockHex, callback) {
        let rpcCommand, rpcArgs;
        if (this.options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{ 'mode': 'submit', 'data': blockHex }];
        }
        this.daemon.cmd(rpcCommand, rpcArgs, (results) => {
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result.error) {
                    this.emitErrorLog('rpc error with daemon instance ' +
                        result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                        JSON.stringify(result.error));
                    return;
                }
                else if (result.response === 'rejected') {
                    this.emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                    return;
                }
            }
            this.emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
            callback();
        }, false, false);
    }
    SetupRecipients() {
        const recipients = [];
        this.options.feePercent = 0;
        this.options.rewardRecipients = this.options.rewardRecipients || {};
        for (const r in this.options.rewardRecipients) {
            if (!this.options.rewardRecipients.hasOwnProperty(r)) {
                continue;
            }
            const percent = this.options.rewardRecipients[r];
            const rObj = {
                percent: percent / 100,
                script: undefined
            };
            try {
                if (r.length === 40)
                    rObj.script = util.miningKeyToScript(r);
                else
                    rObj.script = util.addressToScript(r);
                recipients.push(rObj);
                this.options.feePercent += percent;
            }
            catch (e) {
                this.emitErrorLog('Error generating transaction output script for ' + r + ' in rewardRecipients');
            }
        }
        if (recipients.length === 0) {
            this.emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        this.options.recipients = recipients;
    }
    SetupJobManager() {
        this.jobManager = new jobManager_1.JobManager(this.options);
        this.jobManager.on('newBlock', (blockTemplate) => {
            if (this.stratumServer) {
                this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', (blockTemplate) => {
            if (this.stratumServer) {
                const job = blockTemplate.getJobParams();
                job[8] = false;
                this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', (shareData, blockHex) => {
            let isValidShare = !shareData.error;
            let isValidBlock = !!blockHex;
            const emitShare = function () {
                this.emit('share', isValidShare, isValidBlock, shareData);
            };
            if (!isValidBlock)
                emitShare();
            else {
                this.SubmitBlock(blockHex, () => {
                    this.CheckBlockAccepted(shareData.blockHash, (isAccepted, tx) => {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        this.GetBlockTemplate((error, result, foundNewBlock) => {
                            if (foundNewBlock)
                                this.emitLog('Block notification via RPC after block submission');
                        });
                    });
                });
            }
        }).on('log', (severity, message) => {
            this.emit('log', severity, message);
        });
    }
    SetupDaemonInterface(finishedCallback) {
        if (!Array.isArray(this.options.daemons) || this.options.daemons.length < 1) {
            this.emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }
        this.daemon = new daemon_1.DaemonManager(this.options.daemons, function (severity, message) {
            this.emit('log', severity, message);
        });
        this.daemon.once('online', () => {
            finishedCallback();
        }).on('connectionFailed', (error) => {
            this.emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));
        }).on('error', (message) => {
            this.emitErrorLog(message);
        });
        this.daemon.init();
    }
    DetectCoinData(finishedCallback) {
        const batchRpcCalls = [
            ['validateaddress', [this.options.address]],
            ['getdifficulty', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];
        if (this.options.coin.hasGetInfo) {
            batchRpcCalls.push(['getinfo', []]);
        }
        else {
            batchRpcCalls.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
        }
        this.daemon.batchCmd(batchRpcCalls, (error, results) => {
            if (error || !results) {
                this.emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }
            const rpcResults = {
                "validateaddress": undefined,
                "rpcCall": undefined,
                "getdifficulty": undefined,
                "getinfo": undefined,
                "getmininginfo": undefined,
                "getblockchaininfo": undefined,
                "getnetworkinfo": undefined,
                "submitblock": undefined,
            };
            for (let i = 0; i < results.length; i++) {
                const rpcCall = batchRpcCalls[i][0];
                const r = results[i];
                rpcResults.rpcCall = r.result || r.error;
                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    this.emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }
            if (!rpcResults.validateaddress.isvalid) {
                this.emitErrorLog('Daemon reports address is not valid');
                return;
            }
            if (!this.options.coin.reward) {
                if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                    this.options.coin.reward = 'POS';
                else
                    this.options.coin.reward = 'POW';
            }
            if (this.options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) == 'undefined') {
                this.emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }
            this.options.poolAddressScript = (() => {
                switch (this.options.coin.reward) {
                    case 'POS':
                        return util.pubkeyToScript(rpcResults.validateaddress.pubkey);
                    case 'POW':
                        return util.addressToScript(rpcResults.validateaddress.address);
                }
            })();
            this.options.testnet = this.options.coin.hasGetInfo ? rpcResults.getinfo.testnet : (rpcResults.getblockchaininfo.chain === 'test');
            this.options.protocolVersion = this.options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;
            let difficulty = this.options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
            if (typeof (difficulty) == 'object') {
                difficulty = difficulty['proof-of-work'];
            }
            this.options.initStats = {
                connections: (this.options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections),
                difficulty: difficulty * algoProperties_1.algorithms[this.options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };
            if (rpcResults.submitblock.message === 'Method not found') {
                this.options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1) {
                this.options.hasSubmitMethod = true;
            }
            else {
                this.emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }
            finishedCallback();
        });
    }
    StartStratumServer(finishedCallback) {
        this.stratumServer = new stratum_1.StratumServer(this.options, this.authorizeFn);
        this.stratumServer.on('started', () => {
            this.options.initStats.stratumPorts = Object.keys(this.options.ports);
            this.stratumServer.broadcastMiningJobs(this.jobManager.currentJob.getJobParams());
            finishedCallback();
        }).on('broadcastTimeout', () => {
            this.emitLog('No new blocks for ' + this.options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');
            this.GetBlockTemplate((error, rpcData, processedBlock) => {
                if (error || processedBlock)
                    return;
                this.jobManager.updateCurrentJob(rpcData);
            });
        }).on('client.connected', (client) => {
            if (typeof (this.varDiff[client.socket.localPort]) !== 'undefined') {
                this.varDiff[client.socket.localPort].manageClient(client);
            }
            client.on('difficultyChanged', (diff) => {
                this.emit('difficultyUpdate', client.workerName, diff);
            }).on('subscription', (params, resultCallback) => {
                const extraNonce = this.jobManager.extraNonceCounter.next();
                const extraNonce2Size = this.jobManager.extraNonce2Size;
                resultCallback(null, extraNonce, extraNonce2Size);
                if (typeof (this.options.ports[client.socket.localPort]) !== 'undefined' && this.options.ports[client.socket.localPort].diff) {
                    client.sendDifficulty(this.options.ports[client.socket.localPort].diff);
                }
                else {
                    client.sendDifficulty(8);
                }
                client.sendMiningJob(this.jobManager.currentJob.getJobParams());
            }).on('submit', (params, resultCallback) => {
                const result = this.jobManager.processShare(params.jobId, client.previousDifficulty, client.difficulty, client.extraNonce1, params.extraNonce2, params.nTime, params.nonce, client.remoteAddress, client.socket.localPort, params.name);
                resultCallback(result.error, !!result.result);
            }).on('malformedMessage', (message) => {
                this.emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);
            }).on('socketError', (err) => {
                this.emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));
            }).on('socketTimeout', (reason) => {
                this.emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason);
            }).on('socketDisconnect', () => {
            }).on('kickedBannedIP', (remainingBanTime) => {
                this.emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');
            }).on('forgaveBannedIP', () => {
                this.emitLog('Forgave banned IP ' + client.remoteAddress);
            }).on('unknownStratumMethod', (fullMessage) => {
                this.emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);
            }).on('socketFlooded', () => {
                this.emitWarningLog('Detected socket flooding from ' + client.getLabel());
            }).on('tcpProxyError', (data) => {
                this.emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);
            }).on('bootedBannedWorker', () => {
                this.emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');
            }).on('triggerBan', (reason) => {
                this.emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }
    SetupBlockPolling() {
        if (typeof this.options.blockRefreshInterval !== "number" || this.options.blockRefreshInterval <= 0) {
            this.emitLog('Block template polling has been disabled');
            return;
        }
        const pollingInterval = this.options.blockRefreshInterval;
        this.blockPollingIntervalId = setInterval(() => {
            this.GetBlockTemplate((error, result, foundNewBlock) => {
                if (foundNewBlock)
                    this.emitLog('Block notification via RPC polling');
            });
        }, pollingInterval);
    }
    GetBlockTemplate(callback) {
        this.daemon.cmd('getblocktemplate', [{
            "capabilities": ["coinbasetxn", "workid", "coinbase/append"],
            "rules": ["segwit"]
        }], (result) => {
            if (result.error) {
                this.emitErrorLog('getblocktemplate call failed for daemon instance ' +
                    result.instance.index + ' with error ' + JSON.stringify(result.error));
                callback(result.error);
            }
            else {
                const processedNewBlock = this.jobManager.processTemplate(result.response);
                callback(null, result.response, processedNewBlock);
                callback = function () { };
            }
        }, true, false);
    }
    CheckBlockAccepted(blockHash, callback) {
        this.daemon.cmd('getblock', [blockHash], function (results) {
            const validResults = results.filter(function (result) {
                return result.response && (result.response.hash === blockHash);
            });
            if (validResults.length >= 1) {
                callback(true, validResults[0].response.tx[0]);
            }
            else {
                callback(false);
            }
        }, false, false);
    }
    processBlockNotify(blockHash, sourceTrigger) {
        this.emitLog('Block notification via ' + sourceTrigger);
        if (typeof (this.jobManager.currentJob) !== 'undefined' && blockHash !== this.jobManager.currentJob.rpcData.previousblockhash) {
            this.GetBlockTemplate((error, result) => {
                if (error)
                    this.emitErrorLog('Block notify error getting block template for ' + this.options.coin.name);
            });
        }
    }
    ;
    relinquishMiners(filterFn, resultCback) {
        const origStratumClients = this.stratumServer.getStratumClients();
        const stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({ subId: subId, client: origStratumClients[subId] });
        });
        async.filter(stratumClients, filterFn, (clientsToRelinquish) => {
            clientsToRelinquish.forEach((cObj) => {
                cObj.client.removeAllListeners();
                this.stratumServer.removeStratumClientBySubId(cObj.subId);
            });
            process.nextTick(function () {
                resultCback(clientsToRelinquish.map(function (item) {
                    return item.client;
                }));
            });
        });
    }
    ;
    attachMiners(miners) {
        miners.forEach((clientObj) => {
            this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        this.stratumServer.broadcastMiningJobs(this.jobManager.currentJob.getJobParams());
    }
    ;
    getStratumServer() {
        return this.stratumServer;
    }
    setVarDiff(port, varDiffConfig) {
        if (typeof (this.varDiff[port]) != 'undefined') {
            this.varDiff[port].removeAllListeners();
        }
        this.varDiff[port] = new varDiff_1.VarDiff(port, varDiffConfig);
        this.varDiff[port].on('newDifficulty', function (client, newDiff) {
            client.enqueueNextDifficulty(newDiff);
        });
    }
    ;
}
exports.Pool = Pool;
