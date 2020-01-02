const net = require('net');
const crypto = require('crypto');
const events = require('events');

const util = require('./util.js');
// P2P is another method for getting new block update notifications from the coin daemon, should be the faster than polling and easier to setup than the blocknotify system.
//Example of p2p in node from TheSeven: http://paste.pm/e54.js

const fixedLenStringBuffer = (s, len) => {
    let buff = Buffer.alloc(len);
    buff.fill(0);
    buff.write(s);
    return buff;
};

const commandStringBuffer = (s) => {
    return fixedLenStringBuffer(s, 12);
};

const readFlowingBytes = (stream, amount, preRead, callback) => {
    let buff = preRead ? preRead : Buffer.from([]);

    buff = Buffer.concat([buff, Buffer.from([])]);
    if (buff.length >= amount) {
        let returnData = buff.slice(0, amount);
        let lopped = buff.length > amount ? buff.slice(amount) : null;
        callback(returnData, lopped);
    } else {
        stream.once('data', readData);
    }
};


/* Reads a set amount of bytes from a flowing stream, argument descriptions:
   - stream to read from, must have data emitter
   - amount of bytes to read
   - preRead argument can be used to set start with an existing data buffer
   - callback returns 1) data buffer and 2) lopped/over-read data */

module.exports = class Peer {
    constructor(options) {
        this.client = net.connect({
            host: options.p2p.host,
            port: options.p2p.port
        }, this.SendVersion);

        this.magic = Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
        this.magicInt = this.magic.readUInt32LE(0);
        this.verack = false;
        this.validConnectionConfig = true;

        // https://en.bitcoin.it/wiki/Protocol_specification#Inventory_Vectors
        this.invCodes = {
            error: 0,
            tx: 1,
            block: 2
        };

        this.networkServices = Buffer.from('0100000000000000', 'hex'); //NODE_NETWORK services (value 1 packed as uint64)
        this.emptyNetAddress = Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');
        this.userAgent = util.varStringBuffer('/node-stratum/');
        this.blockStartHeight = Buffer.from('00000000', 'hex'); //block start_height, can be empty

        //If protocol version is new enough, add do not relay transactions flag byte, outlined in BIP37
        //https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki#extensions-to-existing-messages
        this.relayTransactions = options.p2p.disableTransactions === true ? Buffer.from([false]) : Buffer.from([]);

        this.commands = {
            version: commandStringBuffer('version'),
            inv: commandStringBuffer('inv'),
            verack: commandStringBuffer('verack'),
            addr: commandStringBuffer('addr'),
            getblocks: commandStringBuffer('getblocks')
        };

        this.client.on('close', () => {
            if (verack) {
                this.emit('disconnected');
                this.verack = false;
                Connect();
            } else if (validConnectionConfig) {
                this.emit('connectionRejected');
            }
        });

        this.client.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                validConnectionConfig = false;
                this.emit('connectionFailed');
            } else {
                this.emit('socketError', err);
            }
        });

        readFlowingBytes(client, 24, null, (header, lopped) => {
            let msgMagic = header.readUInt32LE(0);
            if (msgMagic !== this.magicInt) {
                this.emit('error', 'bad magic number from peer');
                while (header.readUInt32LE(0) !== this.magicInt && header.length >= 4) {
                    header = header.slice(1);
                }
                if (header.readUInt32LE(0) === this.magicInt) {
                    beginReadingMessage(header);
                } else {
                    beginReadingMessage(Buffer.from([]));
                }
                return;
            }
            let msgCommand = header.slice(4, 16).toString();
            let msgLength = header.readUInt32LE(16);
            let msgChecksum = header.readUInt32LE(20);
            readFlowingBytes(client, msgLength, lopped, (payload, lopped) => {
                if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                    this.emit('error', 'bad payload - failed checksum');
                    beginReadingMessage(null);
                    return;
                }
                this.HandleMessage(msgCommand, payload);
                this.beginReadingMessage(lopped);
            });
        });
    }

    //Parsing inv message https://en.bitcoin.it/wiki/Protocol_specification#inv
    HandleInv(payload) {
        //sloppy varint decoding
        let count = payload.readUInt8(0);
        payload = payload.slice(1);
        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.slice(2);
        }
        while (count--) {
            switch (payload.readUInt32LE(0)) {
                case invCodes.error:
                    break;
                case invCodes.tx:
                    let tx = payload.slice(4, 36).toString('hex');
                    break;
                case invCodes.block:
                    let block = payload.slice(4, 36).toString('hex');
                    this.emit('blockFound', block);
                    break;
            }
            payload = payload.slice(36);
        }
    }

    HandleMessage(command, payload) {
        this.emit('peerMessage', { command: command, payload: payload });
        switch (command) {
            case commands.inv.toString():
                HandleInv(payload);
                break;
            case commands.verack.toString():
                if (!verack) {
                    verack = true;
                    this.emit('connected');
                }
                break;
            case commands.version.toString():
                SendMessage(commands.verack, Buffer.alloc(0));
                break;
            default:
                break;
        }

    }

    //Message structure defined at: https://en.bitcoin.it/wiki/Protocol_specification#Message_structure
    SendMessage(command, payload) {
        let message = Buffer.concat([
            magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).slice(0, 4),
            payload
        ]);
        this.client.write(message);
        this.emit('sentMessage', message);
    }

    SendVersion() {
        let payload = Buffer.concat([
            util.packUInt32LE(options.protocolVersion),
            networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            emptyNetAddress, //addr_recv, can be empty
            emptyNetAddress, //addr_from, can be empty
            crypto.pseudoRandomBytes(8), //nonce, random unique ID
            userAgent,
            blockStartHeight,
            relayTransactions
        ]);
        SendMessage(commands.version, payload);
    }
};