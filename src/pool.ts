import {EventEmitter} from 'events';
import * as async from 'async';

import {VarDiff} from './varDiff';
import './daemon';
import {Peer} from './peer';
import './stratum';
import {JobManager} from './jobManager';
import * as util from './util';
import {algorithms} from "./algoProperties"
import {DaemonManager} from "./daemon";
import {StratumServer} from "./stratum";

/*process.on('uncaughtException', function(err) {
    console.log(err.stack);
    throw err;
});*/

export class Pool extends EventEmitter {
    stratumServer: StratumServer;
    private readonly options: any;
    private readonly authorizeFn: Function;
    private jobManager: any;
    private blockPollingIntervalId;
    private daemon: DaemonManager;
    private peer: Peer;
    private varDiff: {};

    constructor(options: poolOption, authorizeFn: Function) {
        super();
        this.options = options;
        this.authorizeFn = authorizeFn;

        if (!(options.coin.algorithm in algorithms)) {
            this.emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
            throw new Error();
        }
    }

    emitLog(text: string) {
        this.emit('log', 'debug', text);
    }

    emitWarningLog(text: string) {
        this.emit('log', 'warning', text);
    }

    emitErrorLog(text: string) {
        this.emit('log', 'error', text);
    }

    emitSpecialLog(text: string) {
        this.emit('log', 'special', text);
    }

    start() {
        const _this = this;

        this.SetupVarDiff();
        this.SetupApi();
        this.SetupDaemonInterface(function () {
            _this.DetectCoinData(function () {
                _this.SetupRecipients();
                _this.SetupJobManager();
                _this.OnBlockchainSynced(function () {
                    _this.GetFirstJob(function () {
                        _this.SetupBlockPolling();
                        _this.SetupPeer();
                        _this.StartStratumServer(function () {
                            _this.OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };

    GetFirstJob(finishedCallback) {
        const _this = this;

        this.GetBlockTemplate(function (error, result) {
            if (error) {
                _this.emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            let portWarnings = [];

            let networkDiffAdjusted = _this.options.initStats.difficulty;

            Object.keys(_this.options.ports).forEach(function (port) {
                let portDiff = _this.options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                let warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                _this.emitWarningLog(warnMessage);
            }

            finishedCallback();
        });
    }

    OutputPoolInfo() {
        const _this = this;
        let startMessage = 'Stratum Pool Server Started for ' + this.options.coin.name +
            ' [' + this.options.coin.symbol.toUpperCase() + '] {' + this.options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0'){
            this.emitLog(startMessage);
            return;
        }
        let infoLines = [startMessage,
            'Network Connected:\t' + (this.options.testnet ? 'Testnet' : 'Mainnet'),
            'Detected Reward Type:\t' + this.options.coin.reward,
            'Current Block Height:\t' + this.jobManager.currentJob.rpcData.height,
            'Current Connect Peers:\t' + this.options.initStats.connections,
            'Current Block Diff:\t' + this.jobManager.currentJob.difficulty * algorithms[this.options.coin.algorithm].multiplier,
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
        const _this = this;
        const generateProgress = function(){

            const cmd = _this.options.coin.hasGetInfo ? 'getinfo' : 'getblockchaininfo';
            _this.daemon.cmd(cmd, [], function(results) {
                const blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], function(results){

                    let peers = results[0].response;
                    let totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    let percent = (blockCount / totalBlocks * 100).toFixed(2);
                    _this.emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                }, false, false);

            }, false, false);
        };
        let checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', [{
                "capabilities": ["coinbasetxn", "workid", "coinbase/append"],
                "rules": ["segwit"]
            }], function (results) {
                let synced: boolean = results.every(function (r) {
                    return !r.error || r.error.code !== -10;
                });
                if (synced) {
                    syncedCallback();
                } else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);

                    //Only let the first fork show synced status or the log wil look flooded with it
                    if (!process.env.forkId || process.env.forkId === '0')
                        generateProgress();
                }

            }, false, false);
        };
        checkSynced(function(){
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                _this.emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });

    }

    SetupApi() {
        const _this = this;

        if (typeof (this.options.api) !== 'object' || typeof (this.options.api.start) !== 'function') {
            return;
        } else {
            this.options.api.start(_this);
        }
    }

    SetupPeer() {
        const _this = this;

        if (!this.options.p2p || !this.options.p2p.enabled)
            return;

        if (this.options.testnet && !this.options.coin.peerMagicTestnet) {
            this.emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        } else if (!this.options.coin.peerMagic) {
            this.emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        this.peer = new Peer(this.options);
        this.peer.on('connected', function () {
            _this.emitLog('p2p connection successful');
        }).on('connectionRejected', function(){
            _this.emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function(){
            _this.emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function(e){
            _this.emitErrorLog('p2p connection failed - likely incorrect host or port:' + e);
        }).on('socketError', function(e){
            _this.emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function(msg){
            _this.emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function(hash){
            _this.processBlockNotify(hash, 'p2p');
        });
    }


    SetupVarDiff() {
        const _this = this;

        this.varDiff = {};
        Object.keys(this.options.ports).forEach(function (port) {
            if (_this.options.ports[port].varDiff)
                _this.setVarDiff(port, _this.options.ports[port].varDiff);
        });
    }


    /*
    Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    SubmitBlock(blockHex, callback) {
        const _this = this;

        let rpcCommand, rpcArgs;
        if (this.options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else{
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{'mode': 'submit', 'data': blockHex}];
        }


        this.daemon.cmd(rpcCommand,
            rpcArgs,
            function(results){
                for (let i = 0; i < results.length; i++){
                    const result = results[i];
                    if (result.error) {
                        _this.emitErrorLog('rpc error with daemon instance ' +
                            result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                            JSON.stringify(result.error)
                        );
                        return;
                    }
                    else if (result.response === 'rejected') {
                        _this.emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                        return;
                    }
                }
                _this.emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
                callback();
            }, false, false,
        );

    }


    SetupRecipients() {
        const recipients = [];
        this.options.feePercent = 0;
        this.options.rewardRecipients = this.options.rewardRecipients || {};
        for (const r in this.options.rewardRecipients) {
            if (!this.options.rewardRecipients.hasOwnProperty(r)) {
                continue // handle IDE exception
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
            catch(e){
                this.emitErrorLog('Error generating transaction output script for ' + r + ' in rewardRecipients');
            }
        }
        if (recipients.length === 0){
            this.emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        this.options.recipients = recipients;
    }

    SetupJobManager() {
        const _this = this;

        this.jobManager = new JobManager(this.options);

        this.jobManager.on('newBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function(blockTemplate){
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                const job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function(shareData, blockHex){
            let isValidShare = !shareData.error;
            let isValidBlock = !!blockHex;
            const emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
            If we calculated that the block solution was found,
            before we emit the share, lets submit the block,
            then check if it was accepted using RPC getblock
            */
            if (!isValidBlock)
                emitShare();
            else{
                _this.SubmitBlock(blockHex, function () {
                    _this.CheckBlockAccepted(shareData.blockHash, function (isAccepted, tx) {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();

                        _this.GetBlockTemplate(function (error, result, foundNewBlock) {
                            if (foundNewBlock)
                                _this.emitLog('Block notification via RPC after block submission');
                        });

                    });
                });
            }
        }).on('log', function(severity, message){
            _this.emit('log', severity, message);
        });
    }

    SetupDaemonInterface(finishedCallback) {
        const _this = this;

        if (!Array.isArray(_this.options.daemons) || _this.options.daemons.length < 1) {
            this.emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }

        this.daemon = new DaemonManager(_this.options.daemons, function (severity, message) {
            _this.emit('log', severity , message);
        });

        this.daemon.once('online', function () {
            finishedCallback();

        }).on('connectionFailed', function(error){
            _this.emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));

        }).on('error', function(message){
            _this.emitErrorLog(message);
        });

        this.daemon.init();
    }

    DetectCoinData(finishedCallback) {
        const _this = this;

        const batchRpcCalls = [
            ['validateaddress', [this.options.address]],
            ['getdifficulty', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];

        if (this.options.coin.hasGetInfo) {
            batchRpcCalls.push(['getinfo', []]);
        } else {
            batchRpcCalls.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
        }
        this.daemon.batchCmd(batchRpcCalls, function (error, results) {
            if (error || !results){
                _this.emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
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

            for (let i = 0; i < results.length; i++){
                const rpcCall = batchRpcCalls[i][0];
                const r = results[i];
                rpcResults.rpcCall = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)){
                    _this.emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid){
                _this.emitErrorLog('Daemon reports address is not valid');
                return;
            }

            if (!_this.options.coin.reward) {
                if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                    _this.options.coin.reward = 'POS';
                else
                    _this.options.coin.reward = 'POW';
            }


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
               only given if address is owned by wallet.*/
            if (_this.options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) == 'undefined') {
                _this.emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            _this.options.poolAddressScript = (function () {
                switch (_this.options.coin.reward) {
                    case 'POS':
                        return util.pubkeyToScript(rpcResults.validateaddress.pubkey);
                    case 'POW':
                        return util.addressToScript(rpcResults.validateaddress.address);
                }
            })();

            _this.options.testnet = _this.options.coin.hasGetInfo ? rpcResults.getinfo.testnet : (rpcResults.getblockchaininfo.chain === 'test');

            _this.options.protocolVersion = _this.options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;

            let difficulty = _this.options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
            if (typeof(difficulty) == 'object') {
                difficulty = difficulty['proof-of-work'];
            }

            _this.options.initStats = {
                connections: (_this.options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections),
                difficulty: difficulty * algorithms[_this.options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };


            if (rpcResults.submitblock.message === 'Method not found'){
                _this.options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1){
                _this.options.hasSubmitMethod = true;
            }
            else {
                _this.emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }

            finishedCallback();

        });
    }

    StartStratumServer(finishedCallback) {
        const _this = this;
        this.stratumServer = new StratumServer(this.options, this.authorizeFn);

        this.stratumServer.on('started', function () {
            _this.options.initStats.stratumPorts = Object.keys(_this.options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('broadcastTimeout', function(){
            _this.emitLog('No new blocks for ' + _this.options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            _this.GetBlockTemplate(function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function(client){
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function(diff){
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function(params, resultCallback){

                const extraNonce = _this.jobManager.extraNonceCounter.next();
                const extraNonce2Size = _this.jobManager.extraNonce2Size;
                resultCallback(null,
                    extraNonce,
                    extraNonce2Size
                );

                if (typeof (_this.options.ports[client.socket.localPort]) !== 'undefined' && _this.options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(_this.options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }

                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', function(params, resultCallback){
                const result = _this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name
                );

                resultCallback(result.error, !!result.result);

            }).on('malformedMessage', function (message) {
                _this.emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function(err) {
                _this.emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function(reason){
                _this.emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function() {
                //emitLog('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function(remainingBanTime){
                _this.emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function(){
                _this.emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function(fullMessage) {
                _this.emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function() {
                _this.emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function(data) {
                _this.emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function(){
                _this.emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function(reason){
                _this.emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }

    SetupBlockPolling() {
        const _this = this;
        if (typeof _this.options.blockRefreshInterval !== "number" || _this.options.blockRefreshInterval <= 0) {
            _this.emitLog('Block template polling has been disabled');
            return;
        }

        const pollingInterval = _this.options.blockRefreshInterval;

        _this.blockPollingIntervalId = setInterval(function () {
            _this.GetBlockTemplate(function (error, result, foundNewBlock) {
                if (foundNewBlock)
                    _this.emitLog('Block notification via RPC polling');
            });
        }, pollingInterval);
    }

    GetBlockTemplate(callback) {
        const _this = this;
        this.daemon.cmd('getblocktemplate',
            [{"capabilities": [ "coinbasetxn", "workid", "coinbase/append" ], "rules": [ "segwit" ]}],
            function(result){
                if (result.error){
                    _this.emitErrorLog('getblocktemplate call failed for daemon instance ' +
                        result.instance.index + ' with error ' + JSON.stringify(result.error));
                    callback(result.error);
                } else {
                    const processedNewBlock = _this.jobManager.processTemplate(result.response);
                    callback(null, result.response, processedNewBlock);
                    callback = function(){};
                }
            }, true, false
        );
    }

    CheckBlockAccepted(blockHash, callback) {
        const _this = this;
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
            [blockHash],
            function (results) {
                const validResults = results.filter(function (result) {
                    return result.response && (result.response.hash === blockHash)
                });

                if (validResults.length >= 1) {
                    callback(true, validResults[0].response.tx[0]);
                } else {
                    callback(false);
                }
            }, false, false,
        );
        //}, 500);
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    processBlockNotify(blockHash: Buffer, sourceTrigger: string) {
        const _this = this;
        this.emitLog('Block notification via ' + sourceTrigger);
        if (typeof(_this.jobManager.currentJob) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash){
            _this.GetBlockTemplate(function (error, result) {
                if (error)
                    _this.emitErrorLog('Block notify error getting block template for ' + _this.options.coin.name);
            })
        }
    };


    relinquishMiners(filterFn, resultCback) {
        const _this = this;
        const origStratumClients = this.stratumServer.getStratumClients();
        const stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({subId: subId, client: origStratumClients[subId]});
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish: any) {
                clientsToRelinquish.forEach(function(cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        )
    };


    attachMiners(miners) {
        const _this = this;
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    getStratumServer() {
        return this.stratumServer;
    }


    setVarDiff(port, varDiffConfig) {
        if (typeof (this.varDiff[port]) != 'undefined') {
            this.varDiff[port].removeAllListeners();
        }
        this.varDiff[port] = new VarDiff(port, varDiffConfig);
        this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
                 //Send new difficulty, then force miner to use new diff by resending the
                 //current job parameters but with the "clean jobs" flag set to false
                 //so the miner doesn't restart work and submit duplicate shares
                client.sendDifficulty(newDiff);
                var job = _this.jobManager.currentJob.getJobParams();
                job[8] = false;
                client.sendMiningJob(job);
            }*/

        });
    };
}
