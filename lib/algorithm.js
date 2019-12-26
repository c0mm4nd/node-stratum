const hashing = require("hashing-scrypt"); // choose your prefer algorithm

// make pool support one algorithm only
module.export = class Algorithm {
    static diff1() {
        return 0x00000000ffff0000000000000000000000000000000000000000000000000000;
    }

    static multiplier(){
        return Math.pow(2, 16);
    }

    hash(data) {
        return hashing.hash(data, 1024, 1, 1);
    }
};
