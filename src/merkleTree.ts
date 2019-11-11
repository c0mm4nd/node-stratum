import * as util from './util.js'

/*

Ported from https://github.com/slush0/stratum-mining/blob/master/lib/merkletree.py

 */

export class MerkleTree {
    data: Buffer[];
    steps: Buffer[];

    constructor(data: Buffer[]) {
        this.data = data;
        this.steps = this.calculateSteps(data);
    }

    merkleJoin(h1: Buffer, h2: Buffer): Buffer {
        const joined = Buffer.concat([h1, h2]);
        return util.sha256d(joined);
    }

    calculateSteps(data: Buffer[]): Buffer[] {
        let L = data;
        const steps = [];
        const PreL = [null];
        const StartL = 2;
        let Ll = L.length;

        if (Ll > 1){
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

    withFirst(f: Buffer): Buffer {
        this.steps.forEach(function(s){
            f = util.sha256d(Buffer.concat([f, s]));
        });
        return f;
    }
}

export default MerkleTree