const crypto = require("crypto");
const bs58 = require("bs58");
const BN = require("bn.js");

const addressFromEx = (exAddress, ripmd160Key) => {
    try {
        const versionByte = getVersionByte(exAddress);
        const addrBase = Buffer.concat([versionByte, new Buffer.from(ripmd160Key, "hex")]);
        const checksum = sha256d(addrBase).slice(0, 4);
        const address = Buffer.concat([addrBase, checksum]);
        return bs58.encode(address);
    }
    catch(e){
        return null;
    }
};

const getVersionByte = (addr) => {
    return bs58.decode(addr).slice(0, 1);
};

const sha256 = (buffer) => {
    const hash1 = crypto.createHash("sha256");
    hash1.update(buffer);
    return hash1.digest();
};

const sha256d = (buffer) => {
    return sha256(sha256(buffer));
};

const reverseBuffer = (buff) => {
    const reversed = new Buffer.alloc(buff.length);
    for (let i = buff.length - 1; i >= 0; i--)
        reversed[buff.length - i - 1] = buff[i];
    return reversed;
};

const reverseHex = (hex) => {
    return reverseBuffer(new Buffer.from(hex, "hex")).toString("hex");
};

const reverseByteOrder = (buff) => {
    for (let i = 0; i < 8; i++) buff.writeUInt32LE(buff.readUInt32BE(i * 4), i * 4);
    return reverseBuffer(buff);
};

const uint256BufferFromHash = (hex) => {
    let fromHex = new Buffer.from(hex, "hex");

    if (fromHex.length != 32) {
        const empty = new Buffer.alloc(32);
        empty.fill(0);
        fromHex.copy(empty);
        fromHex = empty;
    }

    return reverseBuffer(fromHex);
};

const hexFromReversedBuffer = (buffer) => {
    return reverseBuffer(buffer).toString("hex");
};


/*
Defined in bitcoin protocol here:
 https://en.bitcoin.it/wiki/Protocol_specification#Variable_length_integer
 */
const varIntBuffer = (n) => {
    let buff;
    if (n < 0xfd)
        return new Buffer.from([n]);
    else if (n <= 0xffff){
        buff = new Buffer.alloc(3);
        buff[0] = 0xfd;
        buff.writeUInt16LE(n, 1);
        return buff;
    }
    else if (n <= 0xffffffff){
        buff = new Buffer.alloc(5);
        buff[0] = 0xfe;
        buff.writeUInt32LE(n, 1);
        return buff;
    }
    else{
        buff = new Buffer.alloc(9);
        buff[0] = 0xff;
        packUInt16LE(n).copy(buff, 1);
        return buff;
    }
};

const varStringBuffer = (string) => {
    const strBuff = new Buffer.from(string);
    return Buffer.concat([varIntBuffer(strBuff.length), strBuff]);
};

/*
"serialized CScript" formatting as defined here:
 https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki#specification
Used to format height and date when putting into script signature:
 https://en.bitcoin.it/wiki/Script
 */
const serializeNumber = (n) => {

    /* Old version that is bugged
    if (n < 0xfd){
        var buff = new Buffer(2);
        buff[0] = 0x1;
        buff.writeUInt8(n, 1);
        return buff;
    }
    else if (n <= 0xffff){
        var buff = new Buffer(4);
        buff[0] = 0x3;
        buff.writeUInt16LE(n, 1);
        return buff;
    }
    else if (n <= 0xffffffff){
        var buff = new Buffer(5);
        buff[0] = 0x4;
        buff.writeUInt32LE(n, 1);
        return buff;
    }
    else{
        return Buffer.concat([new Buffer([0x9]), binpack.packUInt64(n, 'little')]);
    }*/

    //New version from TheSeven
    if (n >= 1 && n <= 16) return new Buffer.from([0x50 + n]);
    let l = 1;
    const buff = new Buffer.alloc(9);
    while (n > 0x7f)
    {
        buff.writeUInt8(n & 0xff, l++);
        n >>= 8;
    }
    buff.writeUInt8(l, 0);
    buff.writeUInt8(n, l++);
    return buff.slice(0, l);

};


/*
Used for serializing strings used in script signature
 */
const serializeString = (s) => {
    if (s.length < 253)
        return Buffer.concat([
            new Buffer.from([s.length]),
            new Buffer.from(s)
        ]);
    else if (s.length < 0x10000)
        return Buffer.concat([
            new Buffer.from([253]),
            packUInt16LE(s.length),
            new Buffer.from(s)
        ]);
    else if (s.length < 0x100000000)
        return Buffer.concat([
            new Buffer.from([254]),
            packUInt32LE(s.length),
            new Buffer.from(s)
        ]);
    else
        return Buffer.concat([
            new Buffer.from([255]),
            packUInt16LE(s.length),
            new Buffer.from(s)
        ]);
};

const packUInt16LE = (num) => {
    const buff = new Buffer.alloc(2);
    buff.writeUInt16LE(num, 0);
    return buff;
};

const packUInt16BE = (num) => {
    const buff = new Buffer.alloc(2);
    buff.writeUInt16BE(num, 0);
    return buff;
};

const packInt32LE = (num) => {
    const buff = new Buffer.alloc(4);
    buff.writeInt32LE(num, 0);
    return buff;
};

const packInt32BE = (num) => {
    const buff = new Buffer.alloc(4);
    buff.writeInt32BE(num, 0);
    return buff;
};

const packUInt32LE = (num) => {
    const buff = new Buffer.alloc(4);
    buff.writeUInt32LE(num, 0);
    return buff;
};

const packUInt32BE = (num) => {
    const buff = new Buffer.alloc(4);
    buff.writeUInt32BE(num, 0);
    return buff;
};

const packInt64LE = (num) => {
    const buff = new Buffer.alloc(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
};


/*
An exact copy of python's range feature. Written by Tadeck:
 http://stackoverflow.com/a/8273091
 */
const range = (start, stop, step) => {
    if (typeof stop == "undefined") {
        stop = start;
        start = 0;
    }
    if (typeof step == "undefined") {
        step = 1;
    }
    if ((step > 0 && start >= stop) || (step < 0 && start <= stop)){
        return [];
    }
    const result = [];
    for (let i = start; step > 0 ? i < stop : i > stop; i += step){
        result.push(i);
    }
    return result;
};


/*
 For POS coins - used to format wallet address for use in generation transaction's output
 */
const pubkeyToScript = (key) => {
    if (key.length !== 66) {
        console.error("Invalid pubkey: " + key);
        throw new Error();
    }
    const pubkey = new Buffer.alloc(35);
    pubkey[0] = 0x21;
    pubkey[34] = 0xac;
    new Buffer.from(key, "hex").copy(pubkey, 1);
    return pubkey;
};


const miningKeyToScript = (key) => {
    const keyBuffer = new Buffer.from(key, "hex");
    return Buffer.concat([new Buffer.from([0x76, 0xa9, 0x14]), keyBuffer, new Buffer.from([0x88, 0xac])]);
};

/*
For POW coins - used to format wallet address for use in generation transaction's output
 */
const addressToScript = (addr) => {

    const decoded = bs58.decode(addr);

    if (decoded.length < 25) {
        console.error("invalid address length for " + addr);
        throw new Error();
    }

    if (!decoded){
        console.error("bs58 decode failed for " + addr);
        throw new Error();
    }

    const pubkey = decoded.slice(1, -4);

    return Buffer.concat([new Buffer.from([0x76, 0xa9, 0x14]), pubkey, new Buffer.from([0x88, 0xac])]);
};

const getReadableHashRateString = (hashrate) => {
    let i = -1;
    const byteUnits = [" KH", " MH", " GH", " TH", " PH"];
    do {
        hashrate = hashrate / 1024;
        i++;
    } while (hashrate > 1024);
    return hashrate.toFixed(2) + byteUnits[i];
};


//Creates a non-truncated max difficulty (diff1) by bitwise right-shifting the max value of a uint256
const shiftMax256Right = (shiftRight) => {

    //Max value uint256 (an array of ones representing 256 enabled bits)
    let arr256 = Array.apply(null, new Array(256)).map(Number.prototype.valueOf, 1);

    //An array of zero bits for how far the max uint256 is shifted right
    const arrLeft = Array.apply(null, new Array(shiftRight)).map(Number.prototype.valueOf, 0);

    //Add zero bits to uint256 and remove the bits shifted out
    arr256 = arrLeft.concat(arr256).slice(0, 256);

    //An array of bytes to convert the bits to, 8 bits in a byte so length will be 32
    const octets = [];

    for (let i = 0; i < 32; i++){

        octets[i] = 0;

        //The 8 bits for this byte
        const bits = arr256.slice(i * 8, i * 8 + 8);

        //Bit math to add the bits into a byte
        for (let f = 0; f < bits.length; f++){
            const multiplier = Math.pow(2, f);
            octets[i] += bits[f] * multiplier;
        }
    }

    return new Buffer.from(octets);
};


const bufferToCompactBits = (startingBuff) => {
    let bn = new BN(startingBuff);
    let buff = bn.toBuffer();
    
    buff = buff.readUInt8(0) > 0x7f ? Buffer.concat([new Buffer([0x00]), buff]) : buff;

    buff = Buffer.concat([new Buffer.from([buff.length]), buff]);
    return buff.slice(0, 4);
};

/*
 Used to convert getblocktemplate bits field into target if target is not included.
 More info: https://en.bitcoin.it/wiki/Target
 */

const bignumFromBitsBuffer = (bitsBuff) => {
    const numBytes = bitsBuff.readUInt8(0);
    let bigBits = new BN(bitsBuff.slice(1));
    return bigBits.mul(
        BN(2).pow((
            BN(8).mul(numBytes - 3)
        ))
    );
};

const bignumFromBitsHex = (bitsString) => {
    const bitsBuff = new Buffer.from(bitsString, "hex");
    return bignumFromBitsBuffer(bitsBuff);
};

const convertBitsToBuff = (bitsBuff) => {
    const target = bignumFromBitsBuffer(bitsBuff);
    let resultBuff = Buffer.alloc(8);
    resultBuff.writeBigUInt64BE(target);
    const buff256 = new Buffer.alloc(32);
    buff256.fill(0);
    resultBuff.copy(buff256, buff256.length - resultBuff.length);
    return buff256;
};

const getTruncatedDiff = (shift) => {
    return convertBitsToBuff(bufferToCompactBits(shiftMax256Right(shift)));
};

module.exports = {
    addressFromEx,
    getVersionByte,
    sha256,
    sha256d,
    reverseBuffer,
    reverseHex,
    reverseByteOrder,
    uint256BufferFromHash,
    hexFromReversedBuffer,
    varIntBuffer,
    varStringBuffer,
    serializeNumber,
    serializeString,
    packUInt16LE,
    packUInt16BE,
    packInt32LE,
    packInt32BE,
    packUInt32LE,
    packUInt32BE,
    packInt64LE,
    range,
    pubkeyToScript,
    miningKeyToScript,
    addressToScript,
    getReadableHashRateString,
    shiftMax256Right,
    bufferToCompactBits,
    bignumFromBitsBuffer,
    bignumFromBitsHex,
    convertBitsToBuff,
    getTruncatedDiff,
};
