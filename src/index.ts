// This file is useless
// import net = require('net');
// import events = require('events');

//Gives us global access to everything we need for each hashing algorithm // NO WAY
// import require('./algoProperties.js');

import {Pool} from './pool'

// var daemon = require('./daemon.js');
// var varDiff = require('./varDiff.js');

export function createPool(poolOption: poolOption, authorizeFn: Function): Object {
    return new Pool(poolOption, authorizeFn);
}