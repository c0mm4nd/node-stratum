"use strict";
Object.defineProperty(exports, "__esModule", {value: true});
const util = require("./util.js");

class MerkleTree {
    constructor(data) {
        this.data = data;
        this.steps = this.calculateSteps(data);
    }
    merkleJoin(h1, h2) {
        const joined = Buffer.concat([h1, h2]);
        return util.sha256d(joined);
    }
    calculateSteps(data) {
        const _this = this;
        let L = data;
        const steps = [];
        const PreL = [null];
        const StartL = 2;
        let Ll = L.length;
        if (Ll > 1) {
            while (true) {
                if (Ll === 1)
                    break;
                steps.push(L[1]);
                if (Ll % 2)
                    L.push(L[L.length - 1]);
                const Ld = [];
                const r = util.range(StartL, Ll, 2);
                r.forEach(function (i) {
                    Ld.push(_this.merkleJoin(L[i], L[i + 1]));
                });
                L = PreL.concat(Ld);
                Ll = L.length;
            }
        }
        return steps;
    }
    withFirst(f) {
        this.steps.forEach(function (s) {
            f = util.sha256d(Buffer.concat([f, s]));
        });
        return f;
    }
}

exports.MerkleTree = MerkleTree;
exports.default = MerkleTree;
