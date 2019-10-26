import * as crypto from 'crypto';
import * as bs58 from 'bs58';

export function addressFromEx(exAddress, ripmd160Key){
    try {
        const versionByte = getVersionByte(exAddress);
        const addrBase = Buffer.concat([versionByte, new Buffer(ripmd160Key, 'hex')]);
        const checksum = sha256d(addrBase).slice(0, 4);
        const address = Buffer.concat([addrBase, checksum]);
        return bs58.encode(address);
    }
    catch(e){
        return null;
    }
}

export function getVersionByte(addr){
    return bs58.decode(addr).slice(0, 1);
}

export function sha256(buffer){
    const hash1 = crypto.createHash('sha256');
    hash1.update(buffer);
    return hash1.digest();
}

export function sha256d(buffer){
    return sha256(sha256(buffer));
}

export function reverseBuffer(buff){
    const reversed = new Buffer(buff.length);
    for (let i = buff.length - 1; i >= 0; i--)
        reversed[buff.length - i - 1] = buff[i];
    return reversed;
}

export function reverseHex(hex){
    return reverseBuffer(new Buffer(hex, 'hex')).toString('hex');
}

export function reverseByteOrder (buff){
    for (let i = 0; i < 8; i++) buff.writeUInt32LE(buff.readUInt32BE(i * 4), i * 4);
    return reverseBuffer(buff);
}

export function uint256BufferFromHash(hex){

    let fromHex = new Buffer(hex, 'hex');

    if (fromHex.length != 32){
        const empty = new Buffer(32);
        empty.fill(0);
        fromHex.copy(empty);
        fromHex = empty;
    }

    return reverseBuffer(fromHex);
}

export function hexFromReversedBuffer(buffer){
    return reverseBuffer(buffer).toString('hex');
}


/*
Defined in bitcoin protocol here:
 https://en.bitcoin.it/wiki/Protocol_specification#Variable_length_integer
 */
export function varIntBuffer(n){
    let buff;
    if (n < 0xfd)
        return new Buffer([n]);
    else if (n <= 0xffff){
        buff = new Buffer(3);
        buff[0] = 0xfd;
        buff.writeUInt16LE(n, 1);
        return buff;
    }
    else if (n <= 0xffffffff){
        buff = new Buffer(5);
        buff[0] = 0xfe;
        buff.writeUInt32LE(n, 1);
        return buff;
    }
    else{
        buff = new Buffer(9);
        buff[0] = 0xff;
        packUInt16LE(n).copy(buff, 1);
        return buff;
    }
}

export function varStringBuffer(string){
    const strBuff = new Buffer(string);
    return Buffer.concat([varIntBuffer(strBuff.length), strBuff]);
}

/*
"serialized CScript" formatting as defined here:
 https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki#specification
Used to format height and date when putting into script signature:
 https://en.bitcoin.it/wiki/Script
 */
export function serializeNumber(n){

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
    if (n >= 1 && n <= 16) return new Buffer([0x50 + n]);
    let l = 1;
    const buff = new Buffer(9);
    while (n > 0x7f)
    {
        buff.writeUInt8(n & 0xff, l++);
        n >>= 8;
    }
    buff.writeUInt8(l, 0);
    buff.writeUInt8(n, l++);
    return buff.slice(0, l);

}


/*
Used for serializing strings used in script signature
 */
export function serializeString(s){

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

export function packUInt16LE(num){
    const buff = new Buffer(2);
    buff.writeUInt16LE(num, 0);
    return buff;
}

export function packInt32LE(num){
    const buff = new Buffer(4);
    buff.writeInt32LE(num, 0);
    return buff;
}

export function packInt32BE(num){
    const buff = new Buffer(4);
    buff.writeInt32BE(num, 0);
    return buff;
}

export function packUInt32LE(num){
    const buff = new Buffer(4);
    buff.writeUInt32LE(num, 0);
    return buff;
}

export function packUInt32BE(num){
    const buff = new Buffer(4);
    buff.writeUInt32BE(num, 0);
    return buff;
}

export function packInt64LE(num){
    const buff = new Buffer(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
}


/*
An exact copy of python's range feature. Written by Tadeck:
 http://stackoverflow.com/a/8273091
 */
export function range(start, stop, step){
    if (typeof stop === 'undefined'){
        stop = start;
        start = 0;
    }
    if (typeof step === 'undefined'){
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
}




/*
 For POS coins - used to format wallet address for use in generation transaction's output
 */
export function pubkeyToScript(key){
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


export function miningKeyToScript(key){
    const keyBuffer = new Buffer(key, 'hex');
    return Buffer.concat([new Buffer([0x76, 0xa9, 0x14]), keyBuffer, new Buffer([0x88, 0xac])]);
}

/*
For POW coins - used to format wallet address for use in generation transaction's output
 */
export function addressToScript(addr){

    const decoded = bs58.decode(addr);

    if (decoded.length != 25){
        console.error('invalid address length for ' + addr);
        throw new Error();
    }

    if (!decoded){
        console.error('bs58 decode failed for ' + addr);
        throw new Error();
    }

    const pubkey = decoded.slice(1, -4);

    return Buffer.concat([new Buffer([0x76, 0xa9, 0x14]), pubkey, new Buffer([0x88, 0xac])]);
}

export function getReadableHashRateString(hashrate){
    let i = -1;
    const byteUnits = [' KH', ' MH', ' GH', ' TH', ' PH'];
    do {
        hashrate = hashrate / 1024;
        i++;
    } while (hashrate > 1024);
    return hashrate.toFixed(2) + byteUnits[i];
}


//Creates a non-truncated max difficulty (diff1) by bitwise right-shifting the max value of a uint256
export function shiftMax256Right(shiftRight){

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

    return new Buffer(octets);
}


export function bufferToCompactBits(startingBuff){
    let bn = startingBuff.readBigUIntBE();
    let buff = Buffer.alloc(8);
    buff.writeBigUInt64BE(bn);
    
    buff = buff.readUInt8(0) > 0x7f ? Buffer.concat([new Buffer([0x00]), buff]) : buff;

    buff = Buffer.concat([new Buffer([buff.length]), buff]);
    return buff.slice(0, 4);
}

/*
 Used to convert getblocktemplate bits field into target if target is not included.
 More info: https://en.bitcoin.it/wiki/Target
 */

export function bignumFromBitsBuffer(bitsBuff: Buffer){
    const numBytes = bitsBuff.readUInt8(0);
    let bigBits = bitsBuff.slice(1).readBigUInt64BE();
    return bigBits * (BigInt(2) ** (BigInt(8) * BigInt(numBytes - 3)));
}

export function bignumFromBitsHex(bitsString){
    const bitsBuff = new Buffer(bitsString, 'hex');
    return bignumFromBitsBuffer(bitsBuff);
}

export function convertBitsToBuff(bitsBuff){
    const target = bignumFromBitsBuffer(bitsBuff);
    let resultBuff = Buffer.alloc(8);
    resultBuff.writeBigUInt64BE(target);
    const buff256 = new Buffer(32);
    buff256.fill(0);
    resultBuff.copy(buff256, buff256.length - resultBuff.length);
    return buff256;
}

export function getTruncatedDiff(shift){
    return convertBitsToBuff(bufferToCompactBits(shiftMax256Right(shift)));
}