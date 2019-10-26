import * as net from 'net';
import * as crypto from 'crypto';
import * as events from 'events';
import * as util from './util.js';
const fixedLenStringBuffer = function (s, len) {
    let buff = new Buffer(len);
    buff.fill(0);
    buff.write(s);
    return buff;
};
const commandStringBuffer = function (s) {
    return fixedLenStringBuffer(s, 12);
};
const readFlowingBytes = function (stream, amount, preRead, callback) {
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
};
export function Peer(options) {
    const _this = this;
    let client;
    const magic = new Buffer(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
    const magicInt = magic.readUInt32LE(0);
    let verack = false;
    let validConnectionConfig = true;
    const invCodes = {
        error: 0,
        tx: 1,
        block: 2
    };
    const networkServices = new Buffer('0100000000000000', 'hex');
    const emptyNetAddress = new Buffer('010000000000000000000000000000000000ffff000000000000', 'hex');
    const userAgent = util.varStringBuffer('/node-stratum/');
    const blockStartHeight = new Buffer('00000000', 'hex');
    const relayTransactions = options.p2p.disableTransactions === true ? new Buffer([false]) : new Buffer([]);
    const commands = {
        version: commandStringBuffer('version'),
        inv: commandStringBuffer('inv'),
        verack: commandStringBuffer('verack'),
        addr: commandStringBuffer('addr'),
        getblocks: commandStringBuffer('getblocks')
    };
    (function init() {
        Connect();
    })();
    function Connect() {
        client = net.connect({
            host: options.p2p.host,
            port: options.p2p.port
        }, function () {
            SendVersion();
        });
        client.on('close', function () {
            if (verack) {
                _this.emit('disconnected');
                verack = false;
                Connect();
            }
            else if (validConnectionConfig)
                _this.emit('connectionRejected');
        });
        client.on('error', function (e) {
            if (e.code === 'ECONNREFUSED') {
                validConnectionConfig = false;
                _this.emit('connectionFailed');
            }
            else
                _this.emit('socketError', e);
        });
        SetupMessageParser(client);
    }
    function SetupMessageParser(client) {
        const beginReadingMessage = function (preRead) {
            readFlowingBytes(client, 24, preRead, function (header, lopped) {
                const msgMagic = header.readUInt32LE(0);
                if (msgMagic !== magicInt) {
                    _this.emit('error', 'bad magic number from peer');
                    while (header.readUInt32LE(0) !== magicInt && header.length >= 4) {
                        header = header.slice(1);
                    }
                    if (header.readUInt32LE(0) === magicInt) {
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
                readFlowingBytes(client, msgLength, lopped, function (payload, lopped) {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        _this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }
                    HandleMessage(msgCommand, payload);
                    beginReadingMessage(lopped);
                });
            });
        };
        beginReadingMessage(null);
    }
    function HandleInv(payload) {
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
                    const tx = payload.slice(4, 36).toString('hex');
                    break;
                case invCodes.block:
                    const block = payload.slice(4, 36).toString('hex');
                    _this.emit('blockFound', block);
                    break;
            }
            payload = payload.slice(36);
        }
    }
    function HandleMessage(command, payload) {
        _this.emit('peerMessage', { command: command, payload: payload });
        switch (command) {
            case commands.inv.toString():
                HandleInv(payload);
                break;
            case commands.verack.toString():
                if (!verack) {
                    verack = true;
                    _this.emit('connected');
                }
                break;
            default:
                break;
        }
    }
    function SendMessage(command, payload) {
        const message = Buffer.concat([
            magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).slice(0, 4),
            payload
        ]);
        client.write(message);
        _this.emit('sentMessage', message);
    }
    function SendVersion() {
        const payload = Buffer.concat([
            util.packUInt32LE(options.protocolVersion),
            networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            emptyNetAddress,
            emptyNetAddress,
            crypto.pseudoRandomBytes(8),
            userAgent,
            blockStartHeight,
            relayTransactions
        ]);
        SendMessage(commands.version, payload);
    }
}
Peer.prototype.__proto__ = events.EventEmitter.prototype;
