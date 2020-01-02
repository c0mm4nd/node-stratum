const myCoin = {
    "name": "Litecoin",
    "symbol": "LTC",
    "algorithm": "scrypt",
};


const Pool = require("./lib/pool");
const pool = new Pool({
    "coin": myCoin,
    "address": "Qbyk864gpbz46XQqgf6DKKqXED9KtfxD2E",
    "rewardRecipients": {},

    "blockRefreshInterval": 1000,
    "jobRebroadcastTimeout": 55,

    "connectionTimeout": 600,

    "emitInvalidBlockHashes": false,
    "tcpProxyProtocol": false,
    "banning": {
        "enabled": true,
        "time": 600,
        "invalidPercent": 50,
        "checkThreshold": 500,
        "purgeInterval": 300
    },

    "ports": {
        "3032": {
            "diff": 8,
            "varDiff": {
                "minDiff": 1,
                "maxDiff": 512,
                "targetTime": 15,
                "retargetTime": 90,
                "variancePercent": 30
            }
        }
    },

    "daemons": [
        {
            "host": "127.0.0.1",
            "port": 19332,
            "user": "litecoinrpc",
            "password": "testnet"
        }
    ],

}, (ip, port , workerName, password, callback) => {
    console.log("Authorize " + workerName + ":" + password + "@" + ip);
    callback({
        error: null,
        authorized: true,
        disconnect: false
    });
});


pool.on("share", function(isValidShare, isValidBlock, data){

    if (isValidBlock)
        console.log("Block found");
    else if (isValidShare)
        console.log("Valid share submitted");
    else if (data.blockHash)
        console.log("We thought a block was found but it was rejected by the daemon");
    else
        console.log("Invalid share submitted");

    console.log("share data: " + JSON.stringify(data));
});



/*
'severity': can be 'debug', 'warning', 'error'
'logKey':   can be 'system' or 'client' indicating if the error
            was caused by our system or a stratum client
*/
pool.on("log", function(severity, logText){
    console.log("[" + severity + "]: " + logText);
});

pool.start();