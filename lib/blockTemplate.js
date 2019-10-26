import MerkleTree from './merkleTree';
import * as transactions from './transactions';
import * as util from './util';
import { diff1 } from './algoProperties';
export function BlockTemplate(jobId, rpcData, poolAddressScript, extraNoncePlaceholder, reward, txMessages, recipients) {
    const submits = [];
    function getMerkleHashes(steps) {
        return steps.map(function (step) {
            return step.toString('hex');
        });
    }
    function getTransactionBuffers(txs) {
        const txHashes = txs.map(function (tx) {
            if (tx.txid !== undefined) {
                return util.uint256BufferFromHash(tx.txid);
            }
            return util.uint256BufferFromHash(tx.hash);
        });
        return [null].concat(txHashes);
    }
    function getVoteData() {
        if (!rpcData.masternode_payments)
            return new Buffer([]);
        return Buffer.concat([util.varIntBuffer(rpcData.votes.length)].concat(rpcData.votes.map(function (vt) {
            return new Buffer(vt, 'hex');
        })));
    }
    this.rpcData = rpcData;
    this.jobId = jobId;
    this.target = rpcData.target ?
        BigInt("0x" + rpcData.target) :
        util.bignumFromBitsHex(rpcData.bits);
    this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));
    this.prevHashReversed = util.reverseByteOrder(new Buffer(rpcData.previousblockhash, 'hex')).toString('hex');
    this.transactionData = Buffer.concat(rpcData.transactions.map(function (tx) {
        return new Buffer(tx.data, 'hex');
    }));
    this.merkleTree = new MerkleTree(getTransactionBuffers(rpcData.transactions));
    this.merkleBranch = getMerkleHashes(this.merkleTree.steps);
    this.generationTransaction = transactions.CreateGeneration(rpcData, poolAddressScript, extraNoncePlaceholder, reward, txMessages, recipients);
    this.serializeCoinbase = function (extraNonce1, extraNonce2) {
        return Buffer.concat([
            this.generationTransaction[0],
            extraNonce1,
            extraNonce2,
            this.generationTransaction[1]
        ]);
    };
    this.serializeHeader = function (merkleRoot, nTime, nonce) {
        let header = new Buffer(80);
        let position = 0;
        header.write(nonce, position, 4, 'hex');
        header.write(rpcData.bits, position += 4, 4, 'hex');
        header.write(nTime, position += 4, 4, 'hex');
        header.write(merkleRoot, position += 4, 32, 'hex');
        header.write(rpcData.previousblockhash, position += 32, 32, 'hex');
        header.writeUInt32BE(rpcData.version, position + 32);
        header = util.reverseBuffer(header);
        return header;
    };
    this.serializeBlock = function (header, coinbase) {
        return Buffer.concat([
            header,
            util.varIntBuffer(this.rpcData.transactions.length + 1),
            coinbase,
            this.transactionData,
            getVoteData(),
            new Buffer(reward === 'POS' ? [0] : [])
        ]);
    };
    this.registerSubmit = function (extraNonce1, extraNonce2, nTime, nonce) {
        const submission = extraNonce1 + extraNonce2 + nTime + nonce;
        if (submits.indexOf(submission) === -1) {
            submits.push(submission);
            return true;
        }
        return false;
    };
    this.getJobParams = function () {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                this.prevHashReversed,
                this.generationTransaction[0].toString('hex'),
                this.generationTransaction[1].toString('hex'),
                this.merkleBranch,
                util.packInt32BE(this.rpcData.version).toString('hex'),
                this.rpcData.bits,
                util.packUInt32BE(this.rpcData.curtime).toString('hex'),
                true
            ];
        }
        return this.jobParams;
    };
}