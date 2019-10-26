import * as events from 'events';
import * as async from 'async';
import { VarDiff } from './varDiff';
import * as daemon from './daemon';
import { Peer } from './peer';
import * as stratum from './stratum';
import { JobManager } from './jobManager';
import * as util from './util';
import { algos } from "./algoProperties";
export function Pool(options, authorizeFn) {
    this.options = options;
    const _this = this;
    let blockPollingIntervalId;
    const emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    const emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    const emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    const emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };
    if (!(options.coin.algorithm in algos)) {
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }
    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };
    function GetFirstJob(finishedCallback) {
        GetBlockTemplate(function (error, result) {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }
            let portWarnings = [];
            let networkDiffAdjusted = options.initStats.difficulty;
            Object.keys(options.ports).forEach(function (port) {
                let portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                let warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }
            finishedCallback();
        });
    }
    function OutputPoolInfo() {
        let startMessage = 'Stratum Pool Server Started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0') {
            emitLog(startMessage);
            return;
        }
        let infoLines = [startMessage,
            'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
            'Detected Reward Type:\t' + options.coin.reward,
            'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
            'Current Connect Peers:\t' + options.initStats.connections,
            'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier,
            'Network Difficulty:\t' + options.initStats.difficulty,
            'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
            'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
            'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];
        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');
        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }
    function OnBlockchainSynced(syncedCallback) {
        const generateProgress = function () {
            const cmd = options.coin.hasGetInfo ? 'getinfo' : 'getblockchaininfo';
            _this.daemon.cmd(cmd, [], function (results) {
                const blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;
                _this.daemon.cmd('getpeerinfo', [], function (results) {
                    let peers = results[0].response;
                    let totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;
                    let percent = (blockCount / totalBlocks * 100).toFixed(2);
                    emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                }, false, false);
            }, false, false);
        };
        let checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', [{
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
        checkSynced(function () {
            if (!process.env.forkId || process.env.forkId === '0')
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });
    }
    function SetupApi() {
        if (typeof (options.api) !== 'object' || typeof (options.api.start) !== 'function') {
            return;
        }
        else {
            options.api.start(_this);
        }
    }
    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled)
            return;
        if (options.testnet && !options.coin.peerMagicTestnet) {
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic) {
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }
        _this.peer = new Peer(options);
        _this.peer.on('connected', function () {
            emitLog('p2p connection successful');
        }).on('connectionRejected', function () {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function () {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function (e) {
            emitErrorLog('p2p connection failed - likely incorrect host or port:' + e);
        }).on('socketError', function (e) {
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function (msg) {
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function (hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }
    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }
    function SubmitBlock(blockHex, callback) {
        let rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{ 'mode': 'submit', 'data': blockHex }];
        }
        _this.daemon.cmd(rpcCommand, rpcArgs, function (results) {
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result.error) {
                    emitErrorLog('rpc error with daemon instance ' +
                        result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                        JSON.stringify(result.error));
                    return;
                }
                else if (result.response === 'rejected') {
                    emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                    return;
                }
            }
            emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
            callback();
        }, false, false);
    }
    function SetupRecipients() {
        const recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};
        for (const r in options.rewardRecipients) {
            if (!options.rewardRecipients.hasOwnProperty(r)) {
                continue;
            }
            const percent = options.rewardRecipients[r];
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
                options.feePercent += percent;
            }
            catch (e) {
                emitErrorLog('Error generating transaction output script for ' + r + ' in rewardRecipients');
            }
        }
        if (recipients.length === 0) {
            emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }
    function SetupJobManager() {
        _this.jobManager = new JobManager(options);
        _this.jobManager.on('newBlock', function (blockTemplate) {
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function (blockTemplate) {
            if (_this.stratumServer) {
                const job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (shareData, blockHex) {
            let isValidShare = !shareData.error;
            let isValidBlock = !!blockHex;
            const emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };
            if (!isValidBlock)
                emitShare();
            else {
                SubmitBlock(blockHex, function () {
                    CheckBlockAccepted(shareData.blockHash, function (isAccepted, tx) {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        GetBlockTemplate(function (error, result, foundNewBlock) {
                            if (foundNewBlock)
                                emitLog('Block notification via RPC after block submission');
                        });
                    });
                });
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }
    function SetupDaemonInterface(finishedCallback) {
        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }
        _this.daemon = new daemon.DaemonInterface(options.daemons, function (severity, message) {
            _this.emit('log', severity, message);
        });
        _this.daemon.once('online', function () {
            finishedCallback();
        }).on('connectionFailed', function (error) {
            emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));
        }).on('error', function (message) {
            emitErrorLog(message);
        });
        _this.daemon.init();
    }
    function DetectCoinData(finishedCallback) {
        const batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];
        if (options.coin.hasGetInfo) {
            batchRpcCalls.push(['getinfo', []]);
        }
        else {
            batchRpcCalls.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
        }
        _this.daemon.batchCmd(batchRpcCalls, function (error, results) {
            if (error || !results) {
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
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
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }
            if (!rpcResults.validateaddress.isvalid) {
                emitErrorLog('Daemon reports address is not valid');
                return;
            }
            if (!options.coin.reward) {
                if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                    options.coin.reward = 'POS';
                else
                    options.coin.reward = 'POW';
            }
            if (options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) == 'undefined') {
                emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }
            options.poolAddressScript = (function () {
                switch (options.coin.reward) {
                    case 'POS':
                        return util.pubkeyToScript(rpcResults.validateaddress.pubkey);
                    case 'POW':
                        return util.addressToScript(rpcResults.validateaddress.address);
                }
            })();
            options.testnet = options.coin.hasGetInfo ? rpcResults.getinfo.testnet : (rpcResults.getblockchaininfo.chain === 'test');
            options.protocolVersion = options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;
            let difficulty = options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
            if (typeof (difficulty) == 'object') {
                difficulty = difficulty['proof-of-work'];
            }
            options.initStats = {
                connections: (options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections),
                difficulty: difficulty * algos[options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };
            if (rpcResults.submitblock.message === 'Method not found') {
                options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1) {
                options.hasSubmitMethod = true;
            }
            else {
                emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }
            finishedCallback();
        });
    }
    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.StratumServer(options, authorizeFn);
        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();
        }).on('broadcastTimeout', function () {
            emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');
            GetBlockTemplate(function (error, rpcData, processedBlock) {
                if (error || processedBlock)
                    return;
                _this.jobManager.updateCurrentJob(rpcData);
            });
        }).on('client.connected', function (client) {
            if (typeof (_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }
            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff);
            }).on('subscription', function (params, resultCallback) {
                const extraNonce = _this.jobManager.extraNonceCounter.next();
                const extraNonce2Size = _this.jobManager.extraNonce2Size;
                resultCallback(null, extraNonce, extraNonce2Size);
                if (typeof (options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                }
                else {
                    this.sendDifficulty(8);
                }
                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());
            }).on('submit', function (params, resultCallback) {
                const result = _this.jobManager.processShare(params.jobId, client.previousDifficulty, client.difficulty, client.extraNonce1, params.extraNonce2, params.nTime, params.nonce, client.remoteAddress, client.socket.localPort, params.name);
                resultCallback(result.error, !!result.result);
            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);
            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));
            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason);
            }).on('socketDisconnect', function () {
            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');
            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);
            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);
            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());
            }).on('tcpProxyError', function (data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);
            }).on('bootedBannedWorker', function () {
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');
            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }
    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled');
            return;
        }
        const pollingInterval = options.blockRefreshInterval;
        blockPollingIntervalId = setInterval(function () {
            GetBlockTemplate(function (error, result, foundNewBlock) {
                if (foundNewBlock)
                    emitLog('Block notification via RPC polling');
            });
        }, pollingInterval);
    }
    function GetBlockTemplate(callback) {
        _this.daemon.cmd('getblocktemplate', [{ "capabilities": ["coinbasetxn", "workid", "coinbase/append"], "rules": ["segwit"] }], function (result) {
            if (result.error) {
                emitErrorLog('getblocktemplate call failed for daemon instance ' +
                    result.instance.index + ' with error ' + JSON.stringify(result.error));
                callback(result.error);
            }
            else {
                const processedNewBlock = _this.jobManager.processTemplate(result.response);
                callback(null, result.response, processedNewBlock);
                callback = function () { };
            }
        }, true, false);
    }
    function CheckBlockAccepted(blockHash, callback) {
        _this.daemon.cmd('getblock', [blockHash], function (results) {
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
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        emitLog('Block notification via ' + sourceTrigger);
        if (typeof (_this.jobManager.currentJob) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            GetBlockTemplate(function (error, result) {
                if (error)
                    emitErrorLog('Block notify error getting block template for ' + options.coin.name);
            });
        }
    };
    this.relinquishMiners = function (filterFn, resultCback) {
        const origStratumClients = this.stratumServer.getStratumClients();
        const stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({ subId: subId, client: origStratumClients[subId] });
        });
        async.filter(stratumClients, filterFn, function (clientsToRelinquish) {
            clientsToRelinquish.forEach(function (cObj) {
                cObj.client.removeAllListeners();
                _this.stratumServer.removeStratumClientBySubId(cObj.subId);
            });
            process.nextTick(function () {
                resultCback(clientsToRelinquish.map(function (item) {
                    return item.client;
                }));
            });
        });
    };
    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
    };
    this.getStratumServer = function () {
        return _this.stratumServer;
    };
    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof (_this.varDiff[port]) != 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new VarDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {
            client.enqueueNextDifficulty(newDiff);
        });
    };
}
Pool.prototype.__proto__ = events.EventEmitter.prototype;
