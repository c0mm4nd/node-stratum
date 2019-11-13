const multiHashing = require("x-hashing");
const diff1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000;

// make pool support one algorithm only
// X16R
const algorithm = {
    multiplier: Math.pow(2, 8),
    hash: () => {
        multiHashing.x16r.apply(this, arguments);
    }
};


module.exports = {algorithm, diff1};
