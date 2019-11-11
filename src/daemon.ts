import * as http from 'http';
// import * as cp from 'child_process';
import * as async from 'async';
import {EventEmitter} from "events";

/**
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
 * - 'user'    : username of the coin for the rpc interface
 * - 'password': password for the rpc interface of the coin
**/

export class Daemon {
    index: string;
    host: string;
    port: number;
    user: string;
    password: string;
}

export class DaemonManager extends EventEmitter {
    private logger;
    private readonly instances;

    constructor(daemons: Daemon[], logger: (severity: string, message: string) => void) {
        super();
        this.logger = logger || function (severity: string, message: string) {
            console.log(severity + ': ' + message);
        };


        this.instances = (function () {
            for (let i = 0; i < daemons.length; i++)
                daemons[i]['index'] = String(i);
            return daemons;
        })();
    }

    public init() {
        this.isOnline((online) => {
            if (online)
                this.emit('online');
        });
    }

    public isOnline(callback: Function) {
        this.cmd('getpeerinfo', [], (results) => {
            const allOnline: boolean = results.every((result) => {
                return !result.error;
            });
            callback(allOnline);
            if (!allOnline)
                this.emit('connectionFailed', results);
        }, false, false);
    }

    public performHttpRequest(instance: Daemon, jsonData: string, callback: Function) {
        const options = {
            hostname: (typeof (instance.host) == 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: instance.user + ':' + instance.password,
            headers: {
                'Content-Length': jsonData.length
            }
        };

        const parseJson = (res: http.IncomingMessage, data: string) => {
            let dataJson;

            if (res.statusCode === 401) {
                this.logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }

            try {
                dataJson = JSON.parse(data);
            } catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan,/g, ":0");
                    parseJson(res, data);
                    return;
                }
                this.logger('error', 'Could not parse rpc data from daemon instance  ' + instance.index
                    + '\nRequest Data: ' + jsonData
                    + '\nReponse Data: ' + data);

            }
            if (dataJson)
                callback(dataJson.error, dataJson, data);
        };

        const req = http.request(options, function (res: http.IncomingMessage) {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                data += chunk;
            });
            res.on('end', function () {
                parseJson(res, data);
            });
        });

        req.on('error', function (e: Error) {
            if (e.name === 'ECONNREFUSED')
                callback({type: 'offline', message: e.message}, null);
            else
                callback({type: 'request error', message: e.message}, null);
        });

        req.end(jsonData);
    }

    batchCmd(cmdArray, callback) {

        const requestJson = [];

        for (let i = 0; i < cmdArray.length; i++){
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

    public cmd(method: string, params: any, callback: Function, streamResults: boolean, returnRawData: boolean) {
        const results = [];

        async.each(this.instances, (instance: Daemon, eachCallback: Function) => {

            let itemFinished = function (error, result, data) {

                const returnObj = {
                    data: undefined,
                    error: error,
                    response: (result || {}).result,
                    instance: instance
                };
                if (returnRawData) returnObj.data = data;
                if (streamResults) callback(returnObj); else results.push(returnObj);
                eachCallback();
                itemFinished = function () {
                };
            };

            const requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });

            this.performHttpRequest(instance, requestJson, function (error, result, data) {
                itemFinished(error, result, data);
            });


        }, function(){
            if (!streamResults){
                callback(results);
            }
        });
    }

}
