// This file is useless
// import net = require('net');
// import events = require('events');

//Gives us global access to everything we need for each hashing algorithm // NO WAY
// import require('./algorithm.js');

const {Pool} = require("./pool");

// var daemon = require('./daemon.js');
// var varDiff = require('./varDiff.js');

module.exports = function createPool(poolOption, authorizeFn) {
    return new Pool(poolOption, authorizeFn);
};