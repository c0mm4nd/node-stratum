import {EventEmitter} from 'events';

/*

Vardiff ported from stratum-mining share-limiter
 https://github.com/ahmedbodi/stratum-mining/blob/master/mining/basic_share_limiter.py

 */

function RingBuffer(maxSize: number): void {
    let data = [];
    let cursor = 0;
    let isFull = false;
    this.append = function(x){
        if (isFull){
            data[cursor] = x;
            cursor = (cursor + 1) % maxSize;
        }
        else{
            data.push(x);
            cursor++;
            if (data.length === maxSize){
                cursor = 0;
                isFull = true;
            }
        }
    };
    this.avg = function(){
        const sum = data.reduce(function (a, b) {
            return a + b
        });
        return sum / (isFull ? maxSize : cursor);
    };
    this.size = function(){
        return isFull ? maxSize : cursor;
    };
    this.clear = function(){
        data = [];
        cursor = 0;
        isFull = false;
    };
}

// Truncate a number to a fixed amount of decimal places
function toFixed(num: number, len: number): number {
    return parseFloat(num.toFixed(len));
}

type varDiffOption = {
    maxDiff: number;
    minDiff: number;
    x2mode: boolean;
    targetTime: number;
    variancePercent: number;
    retargetTime: number;
}

export class VarDiff extends EventEmitter {
    private bufferSize: number;
    private tMin: number;
    private tMax: number;
    private port: any;
    private variance: number;
    private options: varDiffOption;

    constructor(port: any, varDiffOptions: varDiffOption) {
        super();
        this.port = port;
        this.options = varDiffOptions;

        this.variance = varDiffOptions.targetTime * (varDiffOptions.variancePercent / 100);

        this.bufferSize = varDiffOptions.retargetTime / varDiffOptions.targetTime * 4;
        this.tMin = varDiffOptions.targetTime - this.variance;
        this.tMax = varDiffOptions.targetTime + this.variance;
    }

    manageClient(client) {
        const stratumPort = client.socket.localPort;

        if (stratumPort != this.port) {
            console.error("Handling a client which is not of this vardiff?");
        }


        let lastTs;
        let lastRtc;
        let timeBuffer;

        client.on('submit', () => {
            const ts = (Date.now() / 1000) | 0;

            if (!lastRtc){
                lastRtc = ts - this.options.retargetTime / 2;
                lastTs = ts;
                timeBuffer = new RingBuffer(this.bufferSize);
                return;
            }

            const sinceLast = ts - lastTs;

            timeBuffer.append(sinceLast);
            lastTs = ts;

            if ((ts - lastRtc) < this.options.retargetTime && timeBuffer.size() > 0)
                return;

            lastRtc = ts;
            const avg = timeBuffer.avg();
            let ddiff = this.options.targetTime / avg;

            if (avg > this.tMax && client.difficulty > this.options.minDiff) {
                if (this.options.x2mode) {
                    ddiff = 0.5;
                }
                if (ddiff * client.difficulty < this.options.minDiff) {
                    ddiff = this.options.minDiff / client.difficulty;
                }
            } else if (avg < this.tMin) {
                if (this.options.x2mode) {
                    ddiff = 2;
                }
                const diffMax = this.options.maxDiff;
                if (ddiff * client.difficulty > diffMax) {
                    ddiff = diffMax / client.difficulty;
                }
            }
            else{
                return;
            }

            const newDiff = toFixed(client.difficulty * ddiff, 8);
            timeBuffer.clear();
            this.emit('newDifficulty', client, newDiff);
        });
    }
}
