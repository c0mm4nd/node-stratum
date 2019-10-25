// This file is useless
// import net = require('net');
// import events = require('events');

//Gives us global access to everything we need for each hashing algorithm // NO WAY
// import require('./algoProperties.js');

var pool = require('./pool.js');

// var daemon = require('./daemon.js');
// var varDiff = require('./varDiff.js');

var createPool = function(poolOptions, authorizeFn){
    var newPool = new pool(poolOptions, authorizeFn);
    return newPool;
};

export {createPool}