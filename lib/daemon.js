import * as http from 'http';
import * as async from 'async';
import {EventEmitter} from "events";

export class Daemon {
}

export class DaemonManager extends EventEmitter {
    constructor(daemons, logger) {
        super();
        this.logger = logger || function (severity, message) {
            console.log(severity + ': ' + message);
        };
        this.instances = (function () {
            for (let i = 0; i < daemons.length; i++)
                daemons[i]['index'] = String(i);
            return daemons;
        })();
    }

    init() {
        const _this = this;
        this.isOnline(function (online) {
            if (online)
                _this.emit('online');
        });
    }

    isOnline(callback) {
        const _this = this;
        this.cmd('getpeerinfo', [], function (results) {
            const allOnline = results.every(function (result) {
                return !results.error;
            });
            callback(allOnline);
            if (!allOnline)
                _this.emit('connectionFailed', results);
        }, false, false);
    }

    performHttpRequest(instance, jsonData, callback) {
        const _this = this;
        const options = {
            hostname: (typeof (instance.host) == 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: instance.user + ':' + instance.password,
            headers: {
                'Content-Length': jsonData.length
            }
        };
        const parseJson = function (res, data) {
            let dataJson;
            if (res.statusCode === 401) {
                _this.logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }
            try {
                dataJson = JSON.parse(data);
            }
            catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan,/g, ":0");
                    parseJson(res, data);
                    return;
                }
                _this.logger('error', 'Could not parse rpc data from daemon instance  ' + instance.index
                    + '\nRequest Data: ' + jsonData
                    + '\nReponse Data: ' + data);
            }
            if (dataJson)
                callback(dataJson.error, dataJson, data);
        };
        const req = http.request(options, function (res) {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                data += chunk;
            });
            res.on('end', function () {
                parseJson(res, data);
            });
        });
        req.on('error', function (e) {
            if (e.name === 'ECONNREFUSED')
                callback({ type: 'offline', message: e.message }, null);
            else
                callback({ type: 'request error', message: e.message }, null);
        });
        req.end(jsonData);
    }

    batchCmd(cmdArray, callback) {
        const requestJson = [];
        for (let i = 0; i < cmdArray.length; i++) {
            requestJson.push({
                method: cmdArray[i][0],
                params: cmdArray[i][1],
                id: Date.now() + Math.floor(Math.random() * 10) + i
            });
        }
        const serializedRequest = JSON.stringify(requestJson);
        this.performHttpRequest(this.instances[0], serializedRequest, function (error, result) {
            callback(error, result);
        });
    }

    cmd(method, params, callback, streamResults, returnRawData) {
        const _this = this;
        const results = [];
        async.each(this.instances, function (instance, eachCallback) {
            let itemFinished = function (error, result, data) {
                const returnObj = {
                    data: undefined,
                    error: error,
                    response: (result || {}).result,
                    instance: instance
                };
                if (returnRawData)
                    returnObj.data = data;
                if (streamResults)
                    callback(returnObj);
                else
                    results.push(returnObj);
                eachCallback();
                itemFinished = function () {
                };
            };
            const requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });
            _this.performHttpRequest(instance, requestJson, function (error, result, data) {
                itemFinished(error, result, data);
            });
        }, function () {
            if (!streamResults) {
                callback(results);
            }
        });
    }
}
