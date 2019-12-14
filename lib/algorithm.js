const hashing = require("hashing-scrypt"); // choose your prefer algorithm
const diff1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000;

// make pool support one algorithm only
const algorithm = {
    multiplier: Math.pow(2, 16),

    hash: (...args) => {
        return hashing.hash(args[0], 1024, 1, 1);
    }
};

module.exports = {algorithm, diff1};
