const net = require("net");
const events = require("events");
const tls = require("tls");

const util = require("./util");



class SubscriptionCounter {
    constructor() {
        this.count = 0;
        this.padding = "deadbeefcafebabe";
    }

    next() {
        this.count++;
        if (Number.MAX_VALUE === this.count) this.count = 0;
        return this.padding + util.packInt64LE(this.count).toString("hex");
    }
}

/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
 **/
class StratumClient extends events.EventEmitter {
    constructor(options) {
        super();
        this.pendingDifficulty = null;
        //private members
        this.options = options;
        this.socket = options.socket;
        this.remoteAddress = options.socket.remoteAddress;
        this.lastActivity = Date.now();
        this.shares = {valid: 0, invalid: 0};

        this.considerBan = (!this.options.banning || !this.options.banning.enabled) ? () => {
            return false;
        } : (shareValid) => {
            if (shareValid === true) this.shares.valid++;
            else this.shares.invalid++;
            const totalShares = this.shares.valid + this.shares.invalid;
            if (totalShares >= this.options.banning.checkThreshold) {
                const percentBad = (this.shares.invalid / totalShares) * 100;
                if (percentBad < this.options.banning.invalidPercent) //reset shares
                    this.shares = {valid: 0, invalid: 0};
                else {
                    this.emit("triggerBan", this.shares.invalid + " out of the last " + totalShares + " shares were invalid");
                    this.socket.destroy();
                    return true;
                }
            }
            return false;
        };
    }

    init() {
        this.setupSocket();
    }

    handleMessage(message) {
        switch (message.method) {
        case "mining.subscribe":
            this.handleSubscribe(message);
            break;
        case "mining.authorize":
            this.handleAuthorize(message, true /*reply to socket*/);
            break;
        case "mining.submit":
            this.lastActivity = Date.now();
            this.handleSubmit(message);
            break;
        case "mining.get_transactions":
            this.sendJson({
                id: null,
                result: [],
                error: true
            });
            break;
        default:
            this.emit("unknownStratumMethod", message);
            break;
        }
    }

    handleSubscribe(message) {
        if (!this.authorized) {
            this.requestedSubscriptionBeforeAuth = true;
        }
        this.emit("subscription", {}, (error, extraNonce1, extraNonce2Size) => {
            if (error) {
                this.sendJson({
                    id: message.id,
                    result: null,
                    error: error
                });
                return;
            }
            this.extraNonce1 = extraNonce1;
            this.sendJson({
                id: message.id,
                result: [
                    [
                        ["mining.set_difficulty", this.options.subscriptionId],
                        ["mining.notify", this.options.subscriptionId]
                    ],
                    extraNonce1,
                    extraNonce2Size
                ],
                error: null
            });
        });
    }

    handleAuthorize(message, replyToSocket) {
        this.workerName = message.params[0];
        this.workerPass = message.params[1];
        this.options.authorizeFn(this.remoteAddress, this.options.socket.localPort, this.workerName, this.workerPass, (result) => {
            this.authorized = (!result.error && result.authorized);

            if (replyToSocket) {
                this.sendJson({
                    id: message.id,
                    result: this.authorized,
                    error: result.error
                });
            }

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                this.options.socket.destroy();
            }
        });
    }

    handleSubmit(message) {
        if (!this.authorized) {
            this.sendJson({
                id: message.id,
                result: null,
                error: [24, "unauthorized worker", null]
            });
            this.considerBan(false);
            return;
        }
        if (!this.extraNonce1) {
            this.sendJson({
                id: message.id,
                result: null,
                error: [25, "not subscribed", null]
            });
            this.considerBan(false);
            return;
        }
        this.emit("submit",
            {
                name: message.params[0],
                jobId: message.params[1],
                extraNonce2: message.params[2],
                nTime: message.params[3],
                nonce: message.params[4]
            },
            (error, result) => {
                if (!this.considerBan(result)) {
                    this.sendJson({
                        id: message.id,
                        result: result,
                        error: error
                    });
                }
            }
        );

    }

    sendJson(...args) {
        let response = "";
        for (let i = 0; i < args.length; i++) {
            response += JSON.stringify(args[i]) + "\n";
        }
        this.options.socket.write(response);
    }

    setupSocket() {
        const socket = this.options.socket;
        let dataBuffer = "";
        socket.setEncoding("utf8");

        if (this.options.tcpProxyProtocol === true) {
            socket.once("data", (d) => {
                if (d.indexOf("PROXY") === 0) {
                    this.remoteAddress = d.split(" ")[2];
                } else {
                    this.emit("tcpProxyError", d);
                }
                this.emit("checkBan");
            });
        } else {
            this.emit("checkBan");
        }
        socket.on("data", (d) => {
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, "utf8") > 10240) { //10KB
                dataBuffer = "";
                this.emit("socketFlooded");
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf("\n") !== -1) {
                const messages = dataBuffer.split("\n");
                const incomplete = dataBuffer.slice(-1) === "\n" ? "" : messages.pop();
                messages.forEach((message) => {
                    if (message === "") return;
                    let messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch (e) {
                        if (this.options.tcpProxyProtocol !== true || d.indexOf("PROXY") !== 0) {
                            this.emit("malformedMessage", message);
                            socket.destroy();
                        }
                        return;
                    }

                    if (messageJson) {
                        this.handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on("close", () => {
            this.emit("socketDisconnect");
        });
        socket.on("error", (err) => {
            if (err.code !== "ECONNRESET")
                this.emit("socketError", err);
        });
    }

    getLabel(){
        return (this.workerName || "(unauthorized)") + " [" + this.remoteAddress + "]";
    }

    enqueueNextDifficulty(requestedNewDifficulty) {
        this.pendingDifficulty = requestedNewDifficulty;
        return true;
    }

    sendDifficulty(difficulty) {
        if (difficulty === this.difficulty)
            return false;

        this.previousDifficulty = this.difficulty;
        this.difficulty = difficulty;
        this.sendJson({
            id: null,
            method: "mining.set_difficulty",
            params: [difficulty]//[512],
        });
        return true;
    }

    sendMiningJob(jobParams) {

        const lastActivityAgo = Date.now() - this.lastActivity;
        if (lastActivityAgo > this.options.connectionTimeout * 1000) {
            this.socket.destroy();
            return;
        }

        if (this.pendingDifficulty !== null) {
            const result = this.sendDifficulty(this.pendingDifficulty);
            this.pendingDifficulty = null;
            if (result) {
                this.emit("difficultyChanged", this.difficulty);
            }
        }

        this.sendJson({
            id: null,
            method: "mining.notify",
            params: jobParams
        });

    }

    manuallyAuthClient(username, password) {
        this.handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    }

    manuallySetValues(otherClient) {
        this.extraNonce1 = otherClient.extraNonce1;
        this.previousDifficulty = otherClient.previousDifficulty;
        this.difficulty = otherClient.difficulty;
    }
}


/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
class StratumServer extends events.EventEmitter {
    constructor(options, authorizeFn) {
        super();
        this.options = options;
        this.authorizeFn = authorizeFn;
        this.bannedMS = options.banning ? options.banning.time * 1000 : null;
        this.stratumClients = {};
        this.subscriptionCounter = new SubscriptionCounter();
        this.bannedIPs = {};

        this.init();
    }

    init() {
        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (this.options.banning && this.options.banning.enabled) {
            setInterval(() => {
                for (let ip in this.bannedIPs) {
                    const banTime = this.bannedIPs[ip];
                    if (Date.now() - banTime > this.options.banning.time)
                        delete this.bannedIPs[ip];
                }
            }, 1000 * this.options.banning.purgeInterval);
        }


        // SetupBroadcasting();

        let serversStarted = 0;
        for (let port in this.options.ports) {
            if (this.options.ports[port].tls !== true || this.options.ports[port].tls !== "true") {
                net.createServer({allowHalfOpen: false}, (socket) => {
                    this.handleNewClient(socket);
                }).listen(parseInt(port), () => {
                    serversStarted++;
                    if (serversStarted === Object.keys(this.options.ports).length)
                        this.emit("started");
                });
            } else {
                tls.createServer(this.TLSOptions, (socket) => {
                    this.handleNewClient(socket);
                }).listen(parseInt(port), () => {
                    serversStarted++;
                    if (serversStarted === Object.keys(this.options.ports).length)
                        this.emit("started");
                });
            }
        }
    }

    checkBan(client) {
        if (this.options.banning && this.options.banning.enabled && client.remoteAddress in this.bannedIPs) {
            const bannedTime = this.bannedIPs[client.remoteAddress];
            const bannedTimeAgo = Date.now() - bannedTime;
            const timeLeft = this.bannedMS - bannedTimeAgo;
            if (timeLeft > 0){
                client.socket.destroy();
                client.emit("kickedBannedIP", timeLeft / 1000 | 0);
            }
            else {
                delete this.bannedIPs[client.remoteAddress];
                client.emit("forgaveBannedIP");
            }
        }
    }

    handleNewClient(socket) {
        socket.setKeepAlive(true);
        const subscriptionId = this.subscriptionCounter.next();
        const client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: this.authorizeFn,
                socket: socket,
                banning: this.options.banning,
                connectionTimeout: this.options.connectionTimeout,
                tcpProxyProtocol: this.options.tcpProxyProtocol
            }
        );

        this.stratumClients[subscriptionId] = client;
        this.emit("client.connected", client);
        client.on("socketDisconnect", () => {
            this.removeStratumClientBySubId(subscriptionId);
            this.emit("client.disconnected", client);
        }).on("checkBan", () => {
            this.checkBan(client);
        }).on("triggerBan", () => {
            this.addBannedIP(client.remoteAddress);
        }).init();

        return subscriptionId;
    }

    broadcastMiningJobs(jobParams) {
        for (const clientId in this.stratumClients) {
            const client = this.stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(this.rebroadcastTimeout);
        this.rebroadcastTimeout = setTimeout(() => {
            this.emit("broadcastTimeout");
        }, this.options.jobRebroadcastTimeout * 1000);
    }

    addBannedIP(ipAddress) {
        this.bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    }

    removeStratumClientBySubId(subscriptionId) {
        delete this.stratumClients[subscriptionId];
    }

    getStratumClients() {
        return this.stratumClients;
    }

    manuallyAddStratumClient(clientObj) {
        const subId = this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            this.stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            this.stratumClients[subId].manuallySetValues(clientObj);
        }
    }
}

module.exports = {StratumClient, StratumServer};
