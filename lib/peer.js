"use strict";
Object.defineProperty(exports, "__esModule", {value: true});
const net = require("net");
const crypto = require("crypto");
const events_1 = require("events");
const util = require("./util.js");
function fixedLenStringBuffer(s, len) {
    let buff = new Buffer(len);
    buff.fill(0);
    buff.write(s);
    return buff;
}
function commandStringBuffer(s) {
    return fixedLenStringBuffer(s, 12);
}
function readFlowingBytes(stream, amount, preRead, callback) {
    let buff = preRead ? preRead : new Buffer([]);
    const readData = function (data) {
        buff = Buffer.concat([buff, data]);
        if (buff.length >= amount) {
            const returnData = buff.slice(0, amount);
            const lopped = buff.length > amount ? buff.slice(amount) : null;
            callback(returnData, lopped);
        }
        else
            stream.once('data', readData);
    };
    readData(new Buffer([]));
}
class Peer extends events_1.EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.magic = new Buffer(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
        this.magicInt = this.magic.readUInt32LE(0);
        this.verack = false;
        this.validConnectionConfig = true;
        this.invCodes = {
            error: 0,
            tx: 1,
            block: 2
        };
        this.networkServices = new Buffer('0100000000000000', 'hex');
        this.emptyNetAddress = new Buffer('010000000000000000000000000000000000ffff000000000000', 'hex');
        this.userAgent = util.varStringBuffer('/node-stratum/');
        this.blockStartHeight = new Buffer('00000000', 'hex');
        this.relayTransactions = options.p2p.disableTransactions === true ? new Buffer([false]) : new Buffer([]);
        this.commands = {
            version: commandStringBuffer('version'),
            inv: commandStringBuffer('inv'),
            verack: commandStringBuffer('verack'),
            addr: commandStringBuffer('addr'),
            getblocks: commandStringBuffer('getblocks')
        };
        (() => {
            this.Connect();
        })();
    }
    Connect() {
        this.client = net.connect({
            host: this.options.p2p.host,
            port: this.options.p2p.port
        }, () => {
            this.SendVersion();
        });
        this.client.on('close', () => {
            if (this.verack) {
                this.emit('disconnected');
                this.verack = false;
                this.Connect();
            } else if (this.validConnectionConfig)
                this.emit('connectionRejected');
        });
        this.client.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                this.validConnectionConfig = false;
                this.emit('connectionFailed');
            }
            else
                this.emit('socketError', e);
        });
        this.SetupMessageParser(this.client);
    }
    SetupMessageParser(client) {
        const beginReadingMessage = (preRead) => {
            readFlowingBytes(client, 24, preRead, (header, lopped) => {
                const msgMagic = header.readUInt32LE(0);
                if (msgMagic !== this.magicInt) {
                    this.emit('error', 'bad magic number from peer');
                    while (header.readUInt32LE(0) !== this.magicInt && header.length >= 4) {
                        header = header.slice(1);
                    }
                    if (header.readUInt32LE(0) === this.magicInt) {
                        beginReadingMessage(header);
                    }
                    else {
                        beginReadingMessage(new Buffer([]));
                    }
                    return;
                }
                const msgCommand = header.slice(4, 16).toString();
                const msgLength = header.readUInt32LE(16);
                const msgChecksum = header.readUInt32LE(20);
                readFlowingBytes(client, msgLength, lopped, (payload, lopped) => {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }
                    this.HandleMessage(msgCommand, payload);
                    beginReadingMessage(lopped);
                });
            });
        };
        beginReadingMessage(null);
    }
    HandleInv(payload) {
        let count = payload.readUInt8(0);
        payload = payload.slice(1);
        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.slice(2);
        }
        while (count--) {
            switch (payload.readUInt32LE(0)) {
                case this.invCodes.error:
                    break;
                case this.invCodes.tx:
                    const tx = payload.slice(4, 36).toString('hex');
                    break;
                case this.invCodes.block:
                    const block = payload.slice(4, 36).toString('hex');
                    this.emit('blockFound', block);
                    break;
            }
            payload = payload.slice(36);
        }
    }
    HandleMessage(command, payload) {
        this.emit('peerMessage', {command: command, payload: payload});
        switch (command) {
            case this.commands.inv.toString():
                this.HandleInv(payload);
                break;
            case this.commands.verack.toString():
                if (!this.verack) {
                    this.verack = true;
                    this.emit('connected');
                }
                break;
            default:
                break;
        }
    }
    SendMessage(command, payload) {
        const message = Buffer.concat([
            this.magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).slice(0, 4),
            payload
        ]);
        this.client.write(message);
        this.emit('sentMessage', message);
    }
    SendVersion() {
        const payload = Buffer.concat([
            util.packUInt32LE(this.options.protocolVersion),
            this.networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            this.emptyNetAddress,
            this.emptyNetAddress,
            crypto.pseudoRandomBytes(8),
            this.userAgent,
            this.blockStartHeight,
            this.relayTransactions
        ]);
        this.SendMessage(this.commands.version, payload);
    }
}
exports.Peer = Peer;
