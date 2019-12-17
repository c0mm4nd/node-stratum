//Gives us global access to everything we need for each hashing algorithm // NO WAY

const Pool = require("./pool");

module.exports = function createPool(poolOption, authorizeFn) {
    return new Pool(poolOption, authorizeFn);
};
