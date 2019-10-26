import * as events from 'events';
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
export function VarDiff(port, varDiffOptions) {
    const _this = this;
    let bufferSize, tMin, tMax;
    const variance = varDiffOptions.targetTime * (varDiffOptions.variancePercent / 100);
    bufferSize = varDiffOptions.retargetTime / varDiffOptions.targetTime * 4;
    tMin = varDiffOptions.targetTime - variance;
    tMax = varDiffOptions.targetTime + variance;
    this.manageClient = function (client) {
        const stratumPort = client.socket.localPort;
        if (stratumPort != port) {
            console.error("Handling a client which is not of this vardiff?");
        }
        const options = varDiffOptions;
        let lastTs;
        let lastRtc;
        let timeBuffer;
        client.on('submit', function () {
            const ts = (Date.now() / 1000) | 0;
            if (!lastRtc) {
                lastRtc = ts - options.retargetTime / 2;
                lastTs = ts;
                timeBuffer = new RingBuffer(bufferSize);
                return;
            }
            const sinceLast = ts - lastTs;
            timeBuffer.append(sinceLast);
            lastTs = ts;
            if ((ts - lastRtc) < options.retargetTime && timeBuffer.size() > 0)
                return;
            lastRtc = ts;
            const avg = timeBuffer.avg();
            let ddiff = options.targetTime / avg;
            if (avg > tMax && client.difficulty > options.minDiff) {
                if (options.x2mode) {
                    ddiff = 0.5;
                }
                if (ddiff * client.difficulty < options.minDiff) {
                    ddiff = options.minDiff / client.difficulty;
                }
            }
            else if (avg < tMin) {
                if (options.x2mode) {
                    ddiff = 2;
                }
                const diffMax = options.maxDiff;
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
    };
}
VarDiff.prototype.__proto__ = events.EventEmitter.prototype;
