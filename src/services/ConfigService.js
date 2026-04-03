/*********************************************************************
 * XChain Node - Config Service
 * Path helpers, naming helpers, and getDefaultConfig
 ********************************************************************/

const fs       = require('fs')
const path     = require('path')
const readline = require('readline')

const {
    NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, INDEXER_SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, cryptoNodesDir, dataDir, configDir
} = require('../config/constants')
const { stringToCoin } = require('../utils/helpers')

// --- Path helpers ---

function getModuleDir(module) {
    return moduleDir + "/" + module
}

function getModuleTmpDir(module) {
    return tmpDir + "/" + module
}

function getCryptoNodeDir(coin) {
    if (!(coin in Coin)) {
        coin = stringToCoin(coin)
    }
    return cryptoNodesDir + "/" + Coin[coin]
}

function removeModuleDir(module) {
    fs.rmSync(getModuleDir(module), { recursive: true })
}

function removeModuleTmpDir(module) {
    const dir = getModuleTmpDir(module)
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true })
    }
}

function createModuleTmpDir(module) {
    const dir = getModuleTmpDir(module)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir)
    }
}

function moduleDirExists(module) {
    return fs.existsSync(getModuleDir(module))
}

function checkIfModuleExists(module) {
    const dir = getModuleDir(module)
    return fs.existsSync(dir)
        && fs.existsSync(dir + "/Dockerfile")
        && fs.existsSync(dir + "/src")
        && fs.existsSync(dir + "/package.json")
}

function checkIfCryptoNodeSourceExists(coin) {
    const dir = getCryptoNodeDir(coin)
    return fs.existsSync(dir)
        && fs.existsSync(dir + "/Dockerfile")
        && fs.existsSync(dir + "/src")
}

// --- Naming helpers ---

function getDockerContainerImageNamePrefix(module, coin, network) {
    if (module === DB_MODULE_NAME || module === HUB_MODULE_NAME || module === EXPLORER_MODULE_NAME || module === INDEXER_SYNC_MODULE_NAME) {
        return NODE_PREFIX
    }
    return NODE_PREFIX + SEP + coin + SEP + network
}

function getDockerContainerImageName(module, coin, network) {
    return getDockerContainerImageNamePrefix(module, coin, network) + SEP + module
}

function getDockerNetwork(coin, network) {
    return NODE_PREFIX
        + (coin   !== "" ? SEP + coin    : "")
        + (network !== "" ? SEP + network : "")
}

function getModuleDatabaseName(module, coin, network) {
    const moduleName = module.slice("xchain-".length)
    return "XChain" + DB_SEP
        + CoinTickerSymbol[coin] + DB_SEP
        + network.charAt(0).toUpperCase() + network.slice(1) + DB_SEP
        + moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
}

// --- Default config ---

async function getDefaultConfig(module, coin, network) {
    let defaultValues = null

    if (coin && network) {
        defaultValues = {
            "NETWORK":   network,
            "NODE_URL":  NODE_MODULE_NAME,
            "NODE_PORT": (network === Network.MAINNET ? 8332 : (network === Network.TESTNET ? 18332 : 18444)),
            "NODE_USER": "rpc",
            "NODE_PASSWORD": "rpc",
            "UTXO_TRACKER_URL":              getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coin, network),
            "UTXO_TRACKER_API_PORT":         3001,
            "UTXO_TRACKER_PORT":             3001,
            "UTXO_TRACKER_BOOTSTRAP_VOLUME": dataDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
            "DECODER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_DECODER, coin, network),
            "DECODER_DB_HOST":   "mariadb",
            "DECODER_DB_PORT":   3306,
            "DECODER_DB_USER":   "xchain" + DB_SEP + "decoder" + DB_SEP + coin + DB_SEP + network,
            "DECODER_DB_PASS":   "xchain" + SEP + "password",
            "DECODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_DECODER, coin, network),
            "DECODER_API_PORT":  3002,
            "DECODER_PORT":      3002,
            "DECODER_BOOTSTRAP_VOLUME": dataDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
            "ENCODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_ENCODER, coin, network),
            "ENCODER_API_PORT":  3003,
            "ENCODER_PORT":      3003,
            "INDEXER_HOST":      getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_API_PORT":  3004,
            "INDEXER_PORT":      3004,
            "INDEXER_COIN":      CoinTickerSymbol[coin],
            "INDEXER_NETWORK":   network,
            "INDEXER_DB_HOST":   "mariadb",
            "INDEXER_DB_PORT":   3306,
            "INDEXER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_DB_USER":   "xchain" + DB_SEP + "indexer" + DB_SEP + coin + DB_SEP + network,
            "INDEXER_DB_PASS":   "xchain" + SEP + "password",
            "HUB_HOST":          "127.0.0.1",
            "HUB_API_HOST":      getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":          10000
        }

        if (network === "regtest") {
            defaultValues["REGTEST_MINER_URL"]      = getDockerContainerImageName(XChainService.XCHAIN_REGTEST_MINER, coin, network)
            defaultValues["REGTEST_MINER_API_PORT"] = 3005
            defaultValues["REGTEST_MINER_PORT"]     = 3005
        }
    } else {
        defaultValues = {
            "HUB_HOST":              "127.0.0.1",
            "HUB_API_HOST":          getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":              10000,
            "EXPLORER_HOST":         "127.0.0.1",
            "EXPLORER_PORT":         18080,
            "EXPLORER_API_HOST":     getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
            "EXPLORER_API_USER":     false,
            "EXPLORER_API_PASS":     false,
            "EXPLORER_API_PORT_HTTP":  8080,
            "EXPLORER_PORT_HTTP":      18080,
            "EXPLORER_API_PORT_HTTPS": 8081,
            "EXPLORER_PORT_HTTPS":     18081,
            "SYNC_MODE":               "server",
            "SYNC_API_PORT":           3006,
            "SYNC_PORT":               3006,
            "SYNC_API_HOST":           getDockerContainerImageName(INDEXER_SYNC_MODULE_NAME, "", ""),
            "HUB_API_HOST_SYNC":       getDockerContainerImageName(HUB_MODULE_NAME, "", "")
        }
    }

    // Read the config file for this coin/network pair
    const defaultConfig = {}
    if (coin && network && coin !== "" && network !== "") {
        const configFileStream = fs.createReadStream(configDir + "/" + coin + "-" + network)
        const rl = readline.createInterface({ input: configFileStream, crlfDelay: Infinity })

        for await (const line of rl) {
            const parts = line.split("=")
            if (parts.length === 2) {
                defaultConfig[parts[0]] = parts[1]
            }
        }
    }

    for (const key in defaultValues) {
        if (!(key in defaultConfig)) {
            defaultConfig[key] = defaultValues[key]
        }
    }

    return defaultConfig
}

// --- Command parameter filtering ---

function filterCommandParameters(branch, modules, coins, networks) {
    const servicesList = {}
    let addExplorer = false

    if (coins && coins !== "all") {
        coins = [coins]
    } else {
        coins = Object.values(Coin)
    }

    if (networks && networks !== "all") {
        networks = [networks]
    } else {
        networks = Object.values(Network)
    }

    if (modules === "all") {
        modules = Object.values(XChainService)
        modules.push(NODE_MODULE_NAME)
        addExplorer = true
    } else if (modules === "explorer") {
        addExplorer = true
        coins = []
    } else if (modules === "node") {
        modules = [NODE_MODULE_NAME]
    } else if (modules) {
        modules = [modules]
    }

    if (addExplorer) {
        servicesList[""] = { "": [EXPLORER_MODULE_NAME] }
    }

    for (const nextCoin of coins) {
        if (!(nextCoin in servicesList)) servicesList[nextCoin] = {}

        for (const nextNetwork of networks) {
            if (!(nextNetwork in servicesList[nextCoin])) servicesList[nextCoin][nextNetwork] = []

            for (const nextModule of modules) {
                if (!REGTEST_MODULES.includes(nextModule) || nextNetwork === Network.REGTEST) {
                    servicesList[nextCoin][nextNetwork].push(nextModule)
                }
            }
        }
    }

    return servicesList
}

module.exports = {
    getModuleDir,
    getModuleTmpDir,
    getCryptoNodeDir,
    removeModuleDir,
    removeModuleTmpDir,
    createModuleTmpDir,
    moduleDirExists,
    checkIfModuleExists,
    checkIfCryptoNodeSourceExists,
    getDockerContainerImageNamePrefix,
    getDockerContainerImageName,
    getDockerNetwork,
    getModuleDatabaseName,
    getDefaultConfig,
    filterCommandParameters
}
