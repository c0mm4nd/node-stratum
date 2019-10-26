// This file is useless
// import net = require('net');
// import events = require('events');

//Gives us global access to everything we need for each hashing algorithm // NO WAY
// import require('./algoProperties.js');

import {Pool} from './pool'

// var daemon = require('./daemon.js');
// var varDiff = require('./varDiff.js');

const createPool = function (poolOptions: Object, authorizeFn: Function) {
    return new Pool(poolOptions, authorizeFn);
};

export {createPool}