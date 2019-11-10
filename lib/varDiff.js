import {EventEmitter} from 'events';

function RingBuffer(maxSize) {
    let data = [];
    let cursor = 0;
    let isFull = false;
    this.append = function (x) {
        if (isFull) {
            data[cursor] = x;
            cursor = (cursor + 1) % maxSize;
        }
        else {
            data.push(x);
            cursor++;
            if (data.length === maxSize) {
                cursor = 0;
                isFull = true;
            }
        }
    };
    this.avg = function () {
        const sum = data.reduce(function (a, b) {
            return a + b;
        });
        return sum / (isFull ? maxSize : cursor);
    };
    this.size = function () {
        return isFull ? maxSize : cursor;
    };
    this.clear = function () {
        data = [];
        cursor = 0;
        isFull = false;
    };
}
function toFixed(num, len) {
    return parseFloat(num.toFixed(len));
}

export class VarDiff extends EventEmitter {
    constructor(port, varDiffOptions) {
        super();
        this.port = port;
        this.options = varDiffOptions;
        this.variance = varDiffOptions.targetTime * (varDiffOptions.variancePercent / 100);
        this.bufferSize = varDiffOptions.retargetTime / varDiffOptions.targetTime * 4;
        this.tMin = varDiffOptions.targetTime - this.variance;
        this.tMax = varDiffOptions.targetTime + this.variance;
    }

    manageClient(client) {
        const _this = this;
        const stratumPort = client.socket.localPort;
        if (stratumPort != this.port) {
            console.error("Handling a client which is not of this vardiff?");
        }
        let lastTs;
        let lastRtc;
        let timeBuffer;
        client.on('submit', function () {
            const ts = (Date.now() / 1000) | 0;
            if (!lastRtc) {
                lastRtc = ts - _this.options.retargetTime / 2;
                lastTs = ts;
                timeBuffer = new RingBuffer(_this.bufferSize);
                return;
            }
            const sinceLast = ts - lastTs;
            timeBuffer.append(sinceLast);
            lastTs = ts;
            if ((ts - lastRtc) < _this.options.retargetTime && timeBuffer.size() > 0)
                return;
            lastRtc = ts;
            const avg = timeBuffer.avg();
            let ddiff = _this.options.targetTime / avg;
            if (avg > _this.tMax && client.difficulty > _this.options.minDiff) {
                if (_this.options.x2mode) {
                    ddiff = 0.5;
                }
                if (ddiff * client.difficulty < _this.options.minDiff) {
                    ddiff = _this.options.minDiff / client.difficulty;
                }
            } else if (avg < _this.tMin) {
                if (_this.options.x2mode) {
                    ddiff = 2;
                }
                const diffMax = _this.options.maxDiff;
                if (ddiff * client.difficulty > diffMax) {
                    ddiff = diffMax / client.difficulty;
                }
            }
            else {
                return;
            }
            const newDiff = toFixed(client.difficulty * ddiff, 8);
            timeBuffer.clear();
            _this.emit('newDifficulty', client, newDiff);
        });
    }
}
