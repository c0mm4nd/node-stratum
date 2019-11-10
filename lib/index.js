"use strict";
Object.defineProperty(exports, "__esModule", {value: true});
const pool_1 = require("./pool");

function createPool(poolOption, authorizeFn) {
    return new pool_1.Pool(poolOption, authorizeFn);
}

exports.createPool = createPool;
