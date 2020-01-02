module.exports  = {
    "coin": {
        "name": "Litecoin",
        "symbol": "LTC",
        "algorithm": "scrypt",
    },
    
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
};