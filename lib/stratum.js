import * as net from 'net';
import * as events from 'events';
import * as util from './util.js';
const SubscriptionCounter = function () {
    let count = 0;
    const padding = 'deadbeefcafebabe';
    return {
        next: function () {
            count++;
            if (Number.MAX_VALUE === count)
                count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};
export function StratumClient(options) {
    let pendingDifficulty = null;
    this.socket = options.socket;
    this.remoteAddress = options.socket.remoteAddress;
    const banning = options.banning;
    const _this = this;
    this.lastActivity = Date.now();
    this.shares = { valid: 0, invalid: 0 };
    const considerBan = (!banning || !banning.enabled) ? function () {
        return false;
    } : function (shareValid) {
        if (shareValid === true)
            _this.shares.valid++;
        else
            _this.shares.invalid++;
        const totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold) {
            const percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent)
                _this.shares = { valid: 0, invalid: 0 };
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };
    this.init = function init() {
        setupSocket();
    };
    function handleMessage(message) {
        switch (message.method) {
            case 'mining.subscribe':
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                handleAuthorize(message, true);
                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                sendJson({
                    id: null,
                    result: [],
                    error: true
                });
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }
    function handleSubscribe(message) {
        if (!_this._authorized) {
            _this.requestedSubscriptionBeforeAuth = true;
        }
        _this.emit('subscription', {}, function (error, extraNonce1, extraNonce2Size) {
            if (error) {
                sendJson({
                    id: message.id,
                    result: null,
                    error: error
                });
                return;
            }
            _this.extraNonce1 = extraNonce1;
            sendJson({
                id: message.id,
                result: [
                    [
                        ["mining.set_difficulty", options.subscriptionId],
                        ["mining.notify", options.subscriptionId]
                    ],
                    extraNonce1,
                    extraNonce2Size
                ],
                error: null
            });
        });
    }
    function handleAuthorize(message, replyToSocket) {
        _this.workerName = message.params[0];
        _this.workerPass = message.params[1];
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, function (result) {
            _this.authorized = (!result.error && result.authorized);
            if (replyToSocket) {
                sendJson({
                    id: message.id,
                    result: _this.authorized,
                    error: result.error
                });
            }
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }
    function handleSubmit(message) {
        if (!_this.authorized) {
            sendJson({
                id: message.id,
                result: null,
                error: [24, "unauthorized worker", null]
            });
            considerBan(false);
            return;
        }
        if (!_this.extraNonce1) {
            sendJson({
                id: message.id,
                result: null,
                error: [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }
        _this.emit('submit', {
            name: message.params[0],
            jobId: message.params[1],
            extraNonce2: message.params[2],
            nTime: message.params[3],
            nonce: message.params[4]
        }, function (error, result) {
            if (!considerBan(result)) {
                sendJson({
                    id: message.id,
                    result: result,
                    error: error
                });
            }
        });
    }
    function sendJson(...args) {
        let response = '';
        for (let i = 0; i < args.length; i++) {
            response += JSON.stringify(args[i]) + '\n';
        }
        options.socket.write(response);
    }
    function setupSocket() {
        const socket = options.socket;
        let dataBuffer = '';
        socket.setEncoding('utf8');
        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                }
                else {
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        }
        else {
            _this.emit('checkBan');
        }
        socket.on('data', function (d) {
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) {
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1) {
                const messages = dataBuffer.split('\n');
                const incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function (message) {
                    if (message === '')
                        return;
                    let messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    }
                    catch (e) {
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }
                        return;
                    }
                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function () {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function (err) {
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }
    this.getLabel = function () {
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
    };
    this.enqueueNextDifficulty = function (requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };
    this.sendDifficulty = function (difficulty) {
        if (difficulty === this.difficulty)
            return false;
        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;
        sendJson({
            id: null,
            method: "mining.set_difficulty",
            params: [difficulty]
        });
        return true;
    };
    this.sendMiningJob = function (jobParams) {
        const lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            _this.emit('socketTimeout', 'last submitted a share was ' + (lastActivityAgo / 1000 | 0) + ' seconds ago');
            _this.socket.destroy();
            return;
        }
        if (pendingDifficulty !== null) {
            const result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }
        sendJson({
            id: null,
            method: "mining.notify",
            params: jobParams
        });
    };
    this.manuallyAuthClient = function (username, password) {
        handleAuthorize({ id: 1, params: [username, password] }, false);
    };
    this.manuallySetValues = function (otherClient) {
        _this.extraNonce1 = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty = otherClient.difficulty;
    };
}
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;
export function StratumServer(options, authorizeFn) {
    const bannedMS = options.banning ? options.banning.time * 1000 : null;
    const _this = this;
    const stratumClients = {};
    const subscriptionCounter = SubscriptionCounter();
    let rebroadcastTimeout;
    const bannedIPs = {};
    function checkBan(client) {
        if (options.banning && options.banning.enabled && client.remoteAddress in bannedIPs) {
            const bannedTime = bannedIPs[client.remoteAddress];
            const bannedTimeAgo = Date.now() - bannedTime;
            const timeLeft = bannedMS - bannedTimeAgo;
            if (timeLeft > 0) {
                client.socket.destroy();
                client.emit('kickedBannedIP', timeLeft / 1000 | 0);
            }
            else {
                delete bannedIPs[client.remoteAddress];
                client.emit('forgaveBannedIP');
            }
        }
    }
    this.handleNewClient = function (socket) {
        socket.setKeepAlive(true);
        const subscriptionId = subscriptionCounter.next();
        const client = new StratumClient({
            subscriptionId: subscriptionId,
            authorizeFn: authorizeFn,
            socket: socket,
            banning: options.banning,
            connectionTimeout: options.connectionTimeout,
            tcpProxyProtocol: options.tcpProxyProtocol
        });
        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function () {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function () {
            checkBan(client);
        }).on('triggerBan', function () {
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };
    this.broadcastMiningJobs = function (jobParams) {
        for (const clientId in stratumClients) {
            const client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function () {
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };
    (function init() {
        if (options.banning && options.banning.enabled) {
            setInterval(function () {
                for (let ip in bannedIPs) {
                    const banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval);
        }
        let serversStarted = 0;
        Object.keys(options.ports).forEach(function (port) {
            net.createServer({ allowHalfOpen: false }, function (socket) {
                _this.handleNewClient(socket);
            }).listen(parseInt(port), function () {
                serversStarted++;
                if (serversStarted == Object.keys(options.ports).length)
                    _this.emit('started');
            });
        });
    })();
    this.addBannedIP = function (ipAddress) {
        bannedIPs[ipAddress] = Date.now();
    };
    this.getStratumClients = function () {
        return stratumClients;
    };
    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };
    this.manuallyAddStratumClient = function (clientObj) {
        const subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) {
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };
}
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
