"use strict";
Object.defineProperty(exports, "__esModule", {value: true});
const events_1 = require("events");
const crypto = require("crypto");
const util = require("./util");
const blockTemplate_1 = require("./blockTemplate");
const algoProperties_1 = require("./algoProperties");
class ExtraNonceCounter {
    constructor(configInstanceId) {
        const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
        this.counter = instanceId << 27;
        this.size = 4;
    }
    next() {
        const extraNonce = util.packUInt32BE(Math.abs(this.counter++));
        return extraNonce.toString('hex');
    }
}
class JobCounter {
    constructor() {
        this.counter = 0;
    }
    next() {
        this.counter++;
        if (this.counter % 0xffff === 0)
            this.counter = 1;
        return this.cur();
    }
    ;
    cur() {
        return this.counter.toString(16);
    }
    ;
}

class JobManager extends events_1.EventEmitter {
    constructor(options) {
        super();
        const _this = this;
        this.options = options;
        this.jobCounter = new JobCounter();
        this.shareMultiplier = algoProperties_1.algorithms[options.coin.algorithm].multiplier;
        this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
        this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
        this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;
        this.currentJob = undefined;
        this.validJobs = {};
        this.hashDigest = algoProperties_1.algorithms[options.coin.algorithm].hash(options.coin);
        this.coinbaseHasher = (function () {
            switch (options.coin.algorithm) {
                case 'keccak':
                case 'fugue':
                case 'groestl':
                    if (options.coin.normalHashing === true)
                        return util.sha256d;
                    else
                        return util.sha256;
                default:
                    return util.sha256d;
            }
        })();
        this.blockHasher = (function () {
            switch (options.coin.algorithm) {
                case 'scrypt':
                    if (options.coin.reward === 'POS') {
                        return function (...args) {
                            return util.reverseBuffer(_this.hashDigest.apply(this, args));
                        };
                    }
                    break;
                case 'scrypt-jane':
                    if (options.coin.reward === 'POS') {
                        return function (...args) {
                            return util.reverseBuffer(_this.hashDigest.apply(this, args));
                        };
                    }
                    break;
                case 'scrypt-n':
                    return function (...args) {
                        return util.reverseBuffer(util.sha256d(args[0]));
                    };
                default:
                    return function (...args) {
                        return util.reverseBuffer(_this.hashDigest.apply(this, args));
                    };
            }
        })();
    }
    updateCurrentJob(rpcData) {
        const tmpBlockTemplate = new blockTemplate_1.BlockTemplate(this.jobCounter.next(), rpcData, this.options.poolAddressScript, this.extraNoncePlaceholder, this.options.coin.reward, this.options.coin.txMessages, this.options.recipients);
        this.currentJob = tmpBlockTemplate;
        this.emit('updatedBlock', tmpBlockTemplate, true);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    }
    ;
    processTemplate(rpcData) {
        let isNewBlock = typeof (this.currentJob) == 'undefined';
        if (!isNewBlock && this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;
            if (rpcData.height < this.currentJob.rpcData.height)
                return false;
        }
        if (!isNewBlock)
            return false;
        const tmpBlockTemplate = new blockTemplate_1.BlockTemplate(this.jobCounter.next(), rpcData, this.options.poolAddressScript, this.extraNoncePlaceholder, this.options.coin.reward, this.options.coin.txMessages, this.options.recipients);
        this.currentJob = tmpBlockTemplate;
        this.validJobs = {};
        this.emit('newBlock', tmpBlockTemplate);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
        return true;
    }
    ;
    processShare(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName) {
        const _this = this;
        const shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error};
        };
        const submitTime = Date.now() / 1000 | 0;
        if (extraNonce2.length / 2 !== _this.extraNonce2Size)
            return shareError([20, 'incorrect size of extranonce2']);
        const job = this.validJobs[jobId];
        if (typeof job == 'undefined' || job.jobId != jobId) {
            return shareError([21, 'job not found']);
        }
        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }
        const nTimeInt = parseInt(nTime, 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range']);
        }
        if (nonce.length !== 8) {
            return shareError([20, 'incorrect size of nonce']);
        }
        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }
        const extraNonce1Buffer = new Buffer(extraNonce1, 'hex');
        const extraNonce2Buffer = new Buffer(extraNonce2, 'hex');
        const coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
        const coinbaseHash = this.coinbaseHasher(coinbaseBuffer);
        const merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');
        const headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce);
        const headerHash = this.hashDigest(headerBuffer, nTimeInt);
        const headerBigNum = headerHash.readUInt32LE(0);
        let blockHashInvalid;
        let blockHash;
        let blockHex;
        const shareDiff = algoProperties_1.diff1 / headerBigNum.toNumber() * this.shareMultiplier;
        const blockDiffAdjusted = job.difficulty * this.shareMultiplier;
        if (job.target.ge(headerBigNum)) {
            blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            if (this.options.coin.algorithm === 'blake' || this.options.coin.algorithm === 'neoscrypt') {
                blockHash = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');
            }
            else {
                blockHash = this.blockHasher(headerBuffer, nTime).toString('hex');
            }
        }
        else {
            if (this.options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');
            if (shareDiff / difficulty < 0.99) {
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                }
                else {
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }
            }
        }
        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);
        return { result: true, error: null, blockHash: blockHash };
    }
    ;
}

exports.JobManager = JobManager;
