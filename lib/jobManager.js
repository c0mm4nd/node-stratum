import * as events from 'events';
import * as crypto from 'crypto';
import * as util from './util';
import {BlockTemplate} from './blockTemplate';
import {algos, diff1} from './algoProperties';

const ExtraNonceCounter = function (configInstanceId) {
    const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    let counter = instanceId << 27;
    this.next = function () {
        const extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4;
};
const JobCounter = function () {
    let counter = 0;
    this.next = function () {
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };
    this.cur = function () {
        return counter.toString(16);
    };
};
export function JobManager(options) {
    const _this = this;
    const jobCounter = new JobCounter();
    const shareMultiplier = algos[options.coin.algorithm].multiplier;
    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;
    this.currentJob = undefined;
    this.validJobs = {};
    const hashDigest = algos[options.coin.algorithm].hash(options.coin);
    const coinbaseHasher = (function () {
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
    const blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'scrypt':
                if (options.coin.reward === 'POS') {
                    return function (...args) {
                        return util.reverseBuffer(hashDigest.apply(this, args));
                    };
                }
                break;
            case 'scrypt-jane':
                if (options.coin.reward === 'POS') {
                    return function (...args) {
                        return util.reverseBuffer(hashDigest.apply(this, args));
                    };
                }
                break;
            case 'scrypt-n':
                return function (...args) {
                    return util.reverseBuffer(util.sha256d(args[0]));
                };
            default:
                return function (...args) {
                    return util.reverseBuffer(hashDigest.apply(this, args));
                };
        }
    })();
    this.updateCurrentJob = function (rpcData) {
        const tmpBlockTemplate = new BlockTemplate(jobCounter.next(), rpcData, options.poolAddressScript, _this.extraNoncePlaceholder, options.coin.reward, options.coin.txMessages, options.recipients);
        _this.currentJob = tmpBlockTemplate;
        _this.emit('updatedBlock', tmpBlockTemplate, true);
        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    };
    this.processTemplate = function (rpcData) {
        let isNewBlock = typeof (_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }
        if (!isNewBlock)
            return false;
        const tmpBlockTemplate = new BlockTemplate(jobCounter.next(), rpcData, options.poolAddressScript, _this.extraNoncePlaceholder, options.coin.reward, options.coin.txMessages, options.recipients);
        this.currentJob = tmpBlockTemplate;
        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
        return true;
    };
    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName) {
        const shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };
        const submitTime = Date.now() / 1000 | 0;
        if (extraNonce2.length / 2 !== _this.extraNonce2Size)
            return shareError([20, 'incorrect size of extranonce2']);
        const job = this.validJobs[jobId];
        if (typeof job == 'undefined' || job.jobId !== jobId) {
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
        const coinbaseHash = coinbaseHasher(coinbaseBuffer);
        const merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');
        const headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce);
        const headerHash = hashDigest(headerBuffer, nTimeInt);
        const headerBigNum = headerHash.readUInt32LE(0);
        let blockHashInvalid;
        let blockHash;
        let blockHex;
        const shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
        const blockDiffAdjusted = job.difficulty * shareMultiplier;
        if (job.target.ge(headerBigNum)) {
            blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            if (options.coin.algorithm === 'blake' || options.coin.algorithm === 'neoscrypt') {
                blockHash = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');
            }
            else {
                blockHash = blockHasher(headerBuffer, nTime).toString('hex');
            }
        }
        else {
            if (options.emitInvalidBlockHashes)
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
    };
}
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
