const events = require("events");
const crypto = require("crypto");
const BN = require("bn.js");

const util = require("./util");
const BlockTemplate = require("./blockTemplate");
const { algorithm, diff1 } = require("./algorithm");

//Unique extranonce per subscriber
class ExtraNonceCounter {
    constructor(configInstanceId) {
        const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
        this.counter = instanceId << 27;
        this.size = 4; //bytes
    }

    next() {
        const extraNonce = util.packUInt32BE(Math.abs(this.counter++));
        return extraNonce.toString("hex");
    }
}


//Unique job per new block template
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

    cur() {
        return this.counter.toString(16);
    }
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
**/

module.exports = class JobManager extends events.EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.jobCounter = new JobCounter();

        this.shareMultiplier = algorithm.multiplier;

        //public members

        this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
        this.extraNoncePlaceholder = new Buffer.from("f000000ff111111f", "hex");
        this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

        this.currentJob = undefined;
        this.validJobs = {};

        this.hashDigest = algorithm.hash; //(options.coin);

        this.coinbaseHasher = (() => {
            switch (options.coin.algorithm) {
            case "keccak":
            case "fugue":
            case "groestl":
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
            }
        })();

        this.blockHasher = (block) => {
            return util.reverseBuffer(this.hashDigest(block));
        };

        // switch (options.coin.algorithm) {
        // case "scrypt":
        //     if (options.coin.reward === "POS") {
        //         this.blockHasher = (block)=> {
        //             return util.reverseBuffer(this.hashDigest(block));
        //         };
        //     }
        //     break;
        // }

    }

    updateCurrentJob(rpcData) {
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

        this.emit("updatedBlock", tmpBlockTemplate, true);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    }

    processTemplate(rpcData) {
        /* 
        Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
        block height is greater than the one we have 
        */

        let isNewBlock = typeof (this.currentJob) == "undefined";
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
        this.emit("newBlock", tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    }



    processShare(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName) {
        const shareError = (error) => {
            this.emit("share", {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: undefined };
        };

        const submitTime = Date.now() / 1000 | 0;

        if (extraNonce2.length / 2 !== this.extraNonce2Size) {
            return shareError([20, "incorrect size of extranonce2"]);
        }

        const job = this.validJobs[jobId];
        if (typeof job === "undefined" || job.jobId != jobId) {
            return shareError([21, "job not found"]);
        }

        if (nTime.length !== 8) {
            return shareError([20, "incorrect size of ntime"]);
        }

        const nTimeInt = parseInt(nTime, 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, "ntime out of range"]);
        }

        if (nonce.length !== 8) {
            return shareError([20, "incorrect size of nonce"]);
        }

        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce)) {
            return shareError([22, "duplicate share"]);
        }


        const extraNonce1Buffer = new Buffer.from(extraNonce1, "hex");
        const extraNonce2Buffer = new Buffer.from(extraNonce2, "hex");

        const coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
        const coinbaseHash = this.coinbaseHasher(coinbaseBuffer);

        const merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString("hex");

        const headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce);
        const headerHash = this.hashDigest(headerBuffer, nTimeInt);
        const headerBigNum = new BN(headerHash, 32, "le");

        let blockHashInvalid;
        let blockHash;
        let blockHex;

        const shareDiff = diff1 / headerBigNum * this.shareMultiplier;
        const blockDiffAdjusted = job.difficulty * this.shareMultiplier;

        //Check if share is a block candidate (matched network difficulty)
        if (job.target.gte(headerBigNum)) {
            blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString("hex");
            if (this.options.coin.algorithm === "blake" || this.options.coin.algorithm === "neoscrypt") {
                blockHash = util.reverseBuffer(util.sha256d(headerBuffer, nTime)).toString("hex");
            } else {
                blockHash = this.blockHasher(headerBuffer, nTime).toString("hex");
            }
        } else {
            if (this.options.emitInvalidBlockHashes) {
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString("hex");
            }

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                }
                else {
                    return shareError([23, "low difficulty share of " + shareDiff]);
                }

            }
        }

        this.emit("share", {
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
};
