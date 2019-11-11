import {EventEmitter} from 'events';
import * as crypto from 'crypto';

import * as util from './util';
import {BlockTemplate} from './blockTemplate';
import {algorithms, diff1} from './algoProperties'

//Unique extranonce per subscriber
class ExtraNonceCounter {
    size: number;
    private counter: number;

    constructor(configInstanceId: number) {
        const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
        this.counter = instanceId << 27;
        this.size = 4; //bytes
    }

    next() {
        const extraNonce = util.packUInt32BE(Math.abs(this.counter++));
        return extraNonce.toString('hex');
    }
}


//Unique job per new block template
class JobCounter {
    private counter: number;

    constructor() {
        this.counter = 0;
    }

    next(): string {
        this.counter++;
        if (this.counter % 0xffff === 0)
            this.counter = 1;
        return this.cur();
    };

    cur(): string {
        return this.counter.toString(16);
    };
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
**/

export class JobManager extends EventEmitter {
    private jobCounter: JobCounter;
    private readonly shareMultiplier: number;
    private extraNonceCounter: ExtraNonceCounter;
    private readonly extraNoncePlaceholder: Buffer;
    private readonly extraNonce2Size: number;
    private validJobs: {};
    private currentJob: {
        rpcData: any;
    };
    private hashDigest: any;
    private coinbaseHasher: (buffer: Buffer) => Buffer;
    private blockHasher: (...args) => Buffer;
    private options: poolOption;

    constructor(options: poolOption) {
        super();
        this.options = options;
        this.jobCounter = new JobCounter();

        this.shareMultiplier = algorithms[options.coin.algorithm].multiplier;

        //public members

        this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
        this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
        this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

        this.currentJob = undefined;
        this.validJobs = {};

        this.hashDigest = algorithms[options.coin.algorithm].hash(options.coin);

        this.coinbaseHasher = (function (): (buffer: Buffer) => Buffer {
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

        this.blockHasher = ((): (...args) => Buffer => {
            switch (options.coin.algorithm) {
                case 'scrypt':
                    if (options.coin.reward === 'POS') {
                        return (...args): Buffer => {
                            return util.reverseBuffer(this.hashDigest.apply(this, args));
                        };
                    }
                    break;
                case 'scrypt-jane':
                    if (options.coin.reward === 'POS') {
                        return (...args): Buffer => {
                            return util.reverseBuffer(this.hashDigest.apply(this, args));
                        };
                    }
                    break;
                case 'scrypt-n':
                    return (...args): Buffer => {
                        return util.reverseBuffer(util.sha256d(args[0]));
                    };

                default:
                    return (...args): Buffer => {
                        return util.reverseBuffer(this.hashDigest.apply(this, args));
                    };
            }
        })();
    }

    updateCurrentJob(rpcData): void {

        const tmpBlockTemplate = new BlockTemplate(
            this.jobCounter.next(),
            rpcData,
            this.options.poolAddressScript,
            this.extraNoncePlaceholder,
            this.options.coin.reward,
            this.options.coin.txMessages,
            this.options.recipients
        );

        this.currentJob = tmpBlockTemplate;

        this.emit('updatedBlock', tmpBlockTemplate, true);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    processTemplate(rpcData): boolean {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        let isNewBlock: boolean = typeof (this.currentJob) == 'undefined';
        if (!isNewBlock && this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;


        const tmpBlockTemplate = new BlockTemplate(
            this.jobCounter.next(),
            rpcData,
            this.options.poolAddressScript,
            this.extraNoncePlaceholder,
            this.options.coin.reward,
            this.options.coin.txMessages,
            this.options.recipients
        );

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    processShare(jobId: string, previousDifficulty: number, difficulty: number, extraNonce1: string, extraNonce2: string, nTime: string, nonce: Buffer, ipAddress: any, port: any, workerName: any): { result?: boolean; blockHash?: string; error: [number, string] } {
        const shareError = (error: [number, string]): { error: [number, string]; } => {
            this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error};
        };

        const submitTime = Date.now() / 1000 | 0;

        if (extraNonce2.length / 2 !== this.extraNonce2Size)
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

        const shareDiff = diff1 / headerBigNum.toNumber() * this.shareMultiplier;

        const blockDiffAdjusted = job.difficulty * this.shareMultiplier;

        //Check if share is a block candidate (matched network difficulty)
        if (job.target.ge(headerBigNum)){
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

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99){

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty){
                    difficulty = previousDifficulty;
                }
                else{
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }


        this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff : blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };

}
