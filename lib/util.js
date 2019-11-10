"use strict";
Object.defineProperty(exports, "__esModule", {value: true});
const crypto = require("crypto");
const bs58 = require("bs58");

function addressFromEx(exAddress, ripmd160Key) {
    try {
        const versionByte = getVersionByte(exAddress);
        const addrBase = Buffer.concat([versionByte, new Buffer(ripmd160Key, 'hex')]);
        const checksum = sha256d(addrBase).slice(0, 4);
        const address = Buffer.concat([addrBase, checksum]);
        return bs58.encode(address);
    }
    catch (e) {
        return null;
    }
}

exports.addressFromEx = addressFromEx;

function getVersionByte(addr) {
    return bs58.decode(addr).slice(0, 1);
}

exports.getVersionByte = getVersionByte;

function sha256(buffer) {
    const hash1 = crypto.createHash('sha256');
    hash1.update(buffer);
    return hash1.digest();
}

exports.sha256 = sha256;

function sha256d(buffer) {
    return sha256(sha256(buffer));
}

exports.sha256d = sha256d;

function reverseBuffer(buff) {
    const reversed = new Buffer(buff.length);
    for (let i = buff.length - 1; i >= 0; i--)
        reversed[buff.length - i - 1] = buff[i];
    return reversed;
}

exports.reverseBuffer = reverseBuffer;

function reverseHex(hex) {
    return reverseBuffer(new Buffer(hex, 'hex')).toString('hex');
}

exports.reverseHex = reverseHex;

function reverseByteOrder(buff) {
    for (let i = 0; i < 8; i++)
        buff.writeUInt32LE(buff.readUInt32BE(i * 4), i * 4);
    return reverseBuffer(buff);
}

exports.reverseByteOrder = reverseByteOrder;

function uint256BufferFromHash(hex) {
    let fromHex = new Buffer(hex, 'hex');
    if (fromHex.length != 32) {
        const empty = new Buffer(32);
        empty.fill(0);
        fromHex.copy(empty);
        fromHex = empty;
    }
    return reverseBuffer(fromHex);
}

exports.uint256BufferFromHash = uint256BufferFromHash;

function hexFromReversedBuffer(buffer) {
    return reverseBuffer(buffer).toString('hex');
}

exports.hexFromReversedBuffer = hexFromReversedBuffer;

function varIntBuffer(n) {
    let buff;
    if (n < 0xfd)
        return new Buffer([n]);
    else if (n <= 0xffff) {
        buff = new Buffer(3);
        buff[0] = 0xfd;
        buff.writeUInt16LE(n, 1);
        return buff;
    }
    else if (n <= 0xffffffff) {
        buff = new Buffer(5);
        buff[0] = 0xfe;
        buff.writeUInt32LE(n, 1);
        return buff;
    }
    else {
        buff = new Buffer(9);
        buff[0] = 0xff;
        packUInt16LE(n).copy(buff, 1);
        return buff;
    }
}

exports.varIntBuffer = varIntBuffer;

function varStringBuffer(string) {
    const strBuff = new Buffer(string);
    return Buffer.concat([varIntBuffer(strBuff.length), strBuff]);
}

exports.varStringBuffer = varStringBuffer;

function serializeNumber(n) {
    if (n >= 1 && n <= 16)
        return new Buffer([0x50 + n]);
    let l = 1;
    const buff = new Buffer(9);
    while (n > 0x7f) {
        buff.writeUInt8(n & 0xff, l++);
        n >>= 8;
    }
    buff.writeUInt8(l, 0);
    buff.writeUInt8(n, l++);
    return buff.slice(0, l);
}

exports.serializeNumber = serializeNumber;

function serializeString(s) {
    if (s.length < 253)
        return Buffer.concat([
            new Buffer([s.length]),
            new Buffer(s)
        ]);
    else if (s.length < 0x10000)
        return Buffer.concat([
            new Buffer([253]),
            packUInt16LE(s.length),
            new Buffer(s)
        ]);
    else if (s.length < 0x100000000)
        return Buffer.concat([
            new Buffer([254]),
            packUInt32LE(s.length),
            new Buffer(s)
        ]);
    else
        return Buffer.concat([
            new Buffer([255]),
            packUInt16LE(s.length),
            new Buffer(s)
        ]);
}

exports.serializeString = serializeString;

function packUInt16LE(num) {
    const buff = new Buffer(2);
    buff.writeUInt16LE(num, 0);
    return buff;
}

exports.packUInt16LE = packUInt16LE;

function packInt32LE(num) {
    const buff = new Buffer(4);
    buff.writeInt32LE(num, 0);
    return buff;
}

exports.packInt32LE = packInt32LE;

function packInt32BE(num) {
    const buff = new Buffer(4);
    buff.writeInt32BE(num, 0);
    return buff;
}

exports.packInt32BE = packInt32BE;

function packUInt32LE(num) {
    const buff = new Buffer(4);
    buff.writeUInt32LE(num, 0);
    return buff;
}

exports.packUInt32LE = packUInt32LE;

function packUInt32BE(num) {
    const buff = new Buffer(4);
    buff.writeUInt32BE(num, 0);
    return buff;
}

exports.packUInt32BE = packUInt32BE;

function packInt64LE(num) {
    const buff = new Buffer(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
}

exports.packInt64LE = packInt64LE;

function range(start, stop, step) {
    if (typeof stop == 'undefined') {
        stop = start;
        start = 0;
    }
    if (typeof step == 'undefined') {
        step = 1;
    }
    if ((step > 0 && start >= stop) || (step < 0 && start <= stop)) {
        return [];
    }
    const result = [];
    for (let i = start; step > 0 ? i < stop : i > stop; i += step) {
        result.push(i);
    }
    return result;
}

exports.range = range;

function pubkeyToScript(key) {
    if (key.length !== 66) {
        console.error('Invalid pubkey: ' + key);
        throw new Error();
    }
    const pubkey = new Buffer(35);
    pubkey[0] = 0x21;
    pubkey[34] = 0xac;
    new Buffer(key, 'hex').copy(pubkey, 1);
    return pubkey;
}

exports.pubkeyToScript = pubkeyToScript;

function miningKeyToScript(key) {
    const keyBuffer = new Buffer(key, 'hex');
    return Buffer.concat([new Buffer([0x76, 0xa9, 0x14]), keyBuffer, new Buffer([0x88, 0xac])]);
}

exports.miningKeyToScript = miningKeyToScript;

function addressToScript(addr) {
    const decoded = bs58.decode(addr);
    if (decoded.length != 25) {
        console.error('invalid address length for ' + addr);
        throw new Error();
    }
    if (!decoded) {
        console.error('bs58 decode failed for ' + addr);
        throw new Error();
    }
    const pubkey = decoded.slice(1, -4);
    return Buffer.concat([new Buffer([0x76, 0xa9, 0x14]), pubkey, new Buffer([0x88, 0xac])]);
}

exports.addressToScript = addressToScript;

function getReadableHashRateString(hashrate) {
    let i = -1;
    const byteUnits = [' KH', ' MH', ' GH', ' TH', ' PH'];
    do {
        hashrate = hashrate / 1024;
        i++;
    } while (hashrate > 1024);
    return hashrate.toFixed(2) + byteUnits[i];
}

exports.getReadableHashRateString = getReadableHashRateString;

function shiftMax256Right(shiftRight) {
    let arr256 = Array.apply(null, new Array(256)).map(Number.prototype.valueOf, 1);
    const arrLeft = Array.apply(null, new Array(shiftRight)).map(Number.prototype.valueOf, 0);
    arr256 = arrLeft.concat(arr256).slice(0, 256);
    const octets = [];
    for (let i = 0; i < 32; i++) {
        octets[i] = 0;
        const bits = arr256.slice(i * 8, i * 8 + 8);
        for (let f = 0; f < bits.length; f++) {
            const multiplier = Math.pow(2, f);
            octets[i] += bits[f] * multiplier;
        }
    }
    return new Buffer(octets);
}

exports.shiftMax256Right = shiftMax256Right;

function bufferToCompactBits(startingBuff) {
    let bn = startingBuff.readBigUInt64BE();
    let buff = Buffer.alloc(8);
    buff.writeBigUInt64BE(bn);
    buff = buff.readUInt8(0) > 0x7f ? Buffer.concat([new Buffer([0x00]), buff]) : buff;
    buff = Buffer.concat([new Buffer([buff.length]), buff]);
    return buff.slice(0, 4);
}

exports.bufferToCompactBits = bufferToCompactBits;

function bignumFromBitsBuffer(bitsBuff) {
    const numBytes = bitsBuff.readUInt8(0);
    let bigBits = bitsBuff.slice(1).readBigUInt64BE();
    return bigBits * (BigInt(2) ** (BigInt(8) * BigInt(numBytes - 3)));
}

exports.bignumFromBitsBuffer = bignumFromBitsBuffer;

function bignumFromBitsHex(bitsString) {
    const bitsBuff = new Buffer(bitsString, 'hex');
    return bignumFromBitsBuffer(bitsBuff);
}

exports.bignumFromBitsHex = bignumFromBitsHex;

function convertBitsToBuff(bitsBuff) {
    const target = bignumFromBitsBuffer(bitsBuff);
    let resultBuff = Buffer.alloc(8);
    resultBuff.writeBigUInt64BE(target);
    const buff256 = new Buffer(32);
    buff256.fill(0);
    resultBuff.copy(buff256, buff256.length - resultBuff.length);
    return buff256;
}

exports.convertBitsToBuff = convertBitsToBuff;

function getTruncatedDiff(shift) {
    return convertBitsToBuff(bufferToCompactBits(shiftMax256Right(shift)));
}

exports.getTruncatedDiff = getTruncatedDiff;
