import * as util from './util.js';
export function MerkleTree(data) {
    function merkleJoin(h1, h2) {
        const joined = Buffer.concat([h1, h2]);
        return util.sha256d(joined);
    }
    function calculateSteps(data) {
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
                    Ld.push(merkleJoin(L[i], L[i + 1]));
                });
                L = PreL.concat(Ld);
                Ll = L.length;
            }
        }
        return steps;
    }
    this.data = data;
    this.steps = calculateSteps(data);
}
MerkleTree.prototype = {
    withFirst: function (f) {
        this.steps.forEach(function (s) {
            f = util.sha256d(Buffer.concat([f, s]));
        });
        return f;
    }
};
export default MerkleTree;
