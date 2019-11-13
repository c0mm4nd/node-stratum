const util = require("./util.js");

/*

Ported from https://github.com/slush0/stratum-mining/blob/master/lib/merkletree.py

 */

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
        let L = data;
        const steps = [];
        const PreL = [null];
        const StartL = 2;
        let Ll = L.length;

        if (Ll > 1){
            // eslint-disable-next-line no-constant-condition
            while (true){

                if (Ll === 1)
                    break;

                steps.push(L[1]);

                if (Ll % 2)
                    L.push(L[L.length - 1]);

                const Ld = [];
                const r = util.range(StartL, Ll, 2);
                r.forEach((i) => {
                    Ld.push(this.merkleJoin(L[i], L[i + 1]));
                });
                L = PreL.concat(Ld);
                Ll = L.length;
            }
        }
        return steps;
    }

    withFirst(f) {
        this.steps.forEach(function(s){
            f = util.sha256d(Buffer.concat([f, s]));
        });
        return f;
    }
}

module.exports = MerkleTree;