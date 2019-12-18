const MerkleTree = require("./merkleTree");
const transactions = require("./transactions");
const util = require("./util");
const { diff1 } = require("./algorithm");
const BN = require("bn.js");
/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
 **/
class BlockTemplate {
    constructor(jobId, rpcData, poolAddressScript, extraNoncePlaceholder, reward, txMessages, recipients) {
        this.submits = [];

        this.rpcData = rpcData;
        this.jobId = jobId;
        this.reward = reward;
        this.target = rpcData.target ? new BN(rpcData.target, 16) : util.bignumFromBitsHex(rpcData.bits);

        this.difficulty = parseFloat((diff1 / Number(this.target)).toFixed(9));

        this.prevHashReversed = util.reverseByteOrder(Buffer.from(rpcData.previousblockhash, "hex")).toString("hex");
        this.transactionData = Buffer.concat(rpcData.transactions.map(function (tx) {
            return new Buffer.from(tx.data, "hex");
        }));
        this.merkleTree = new MerkleTree(this.getTransactionBuffers(rpcData.transactions));
        this.merkleBranch = BlockTemplate.getMerkleHashes(this.merkleTree.steps);
        this.generationTransaction = transactions.createGeneration(
            rpcData,
            poolAddressScript,
            extraNoncePlaceholder,
            reward,
            txMessages,
            recipients
        );
    }

    static getMerkleHashes(steps) {
        return steps.map((step) => {
            return step.toString("hex");
        });
    }

    serializeCoinbase(extraNonce1, extraNonce2) {
        return Buffer.concat([
            this.generationTransaction[0],
            extraNonce1,
            extraNonce2,
            this.generationTransaction[1]
        ]);
    }

    serializeBlock(header, coinbase) {
        return Buffer.concat([
            header,

            util.varIntBuffer(this.rpcData.transactions.length + 1),
            coinbase,
            this.transactionData,

            this.getVoteData(),

            //POS coins require a zero byte appended to block which the daemon replaces with the signature
            new Buffer.from(this.reward === "POS" ? [0] : [])
        ]);
    }

    //https://en.bitcoin.it/wiki/Protocol_specification#Block_Headers
    serializeHeader(merkleRoot, nTime, nonce) {
        let header = new Buffer.alloc(80);
        let position = 0;
        header.write(nonce, position, 4, "hex");
        header.write(this.rpcData.bits, position += 4, 4, "hex");
        header.write(nTime, position += 4, 4, "hex");
        header.write(merkleRoot, position += 4, 32, "hex");
        header.write(this.rpcData.previousblockhash, position += 32, 32, "hex");
        header.writeUInt32BE(this.rpcData.version, position + 32);
        header = util.reverseBuffer(header);
        return header;
    }

    registerSubmit(extraNonce1, extraNonce2, nTime, nonce) {
        const submission = extraNonce1 + extraNonce2 + nTime + nonce;
        if (this.submits.indexOf(submission) === -1) {
            this.submits.push(submission);
            return true;
        }
        return false;
    }

    getJobParams() {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                this.prevHashReversed,
                this.generationTransaction[0].toString("hex"),
                this.generationTransaction[1].toString("hex"),
                this.merkleBranch,
                util.packInt32BE(this.rpcData.version).toString("hex"),
                this.rpcData.bits,
                util.packUInt32BE(this.rpcData.curtime).toString("hex"),
                true
            ];
        }
        return this.jobParams;
    }

    getTransactionBuffers(txs) {
        const txHashes = txs.map(function (tx) {
            if (tx.txid !== undefined) {
                return util.uint256BufferFromHash(tx.txid);
            }
            return util.uint256BufferFromHash(tx.hash);
        });
        return [null].concat(txHashes);
    }

    getVoteData() {
        if (!this.rpcData.masternode_payments) return new Buffer.from([]);

        return Buffer.concat(
            [util.varIntBuffer(this.rpcData.votes.length)].concat(
                this.rpcData.votes.map(function (vt) {
                    return new Buffer.from(vt, "hex");
                })
            )
        );
    }
}

module.exports = BlockTemplate;