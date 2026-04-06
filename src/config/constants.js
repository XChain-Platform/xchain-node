/*********************************************************************
 * XChain Node - Constants & Configuration
 ********************************************************************/

const path = require('path')

// --- String constants ---
const NODE_PREFIX            = (process.env.NODE_PREFIX) ? process.env.NODE_PREFIX : "xchain-node"
const DB_NAME                = (process.env.DB_NAME == null) ? "xchain_node" : process.env.DB_NAME
const NODE_MODULE_NAME       = "node"
const DB_MODULE_NAME         = "database"
const HUB_MODULE_NAME        = "xchain-hub"
const EXPLORER_MODULE_NAME   = "xchain-explorer"
const INDEXER_SYNC_MODULE_NAME = "xchain-indexer-sync"
const NODE_VERSION_FILE_NAME = "__VERSION__.txt"
const SEP                    = "-"
const DB_SEP                 = "_"
const HUB_PORT               = 10000

// --- Enums ---
const XChainService = {
    XCHAIN_ENCODER:       "xchain-encoder",
    XCHAIN_DECODER:       "xchain-decoder",
    XCHAIN_UTXO_TRACKER:  "xchain-utxo-tracker",
    XCHAIN_REGTEST_MINER: "xchain-regtest-miner",
    XCHAIN_INDEXER:       "xchain-indexer",
    XCHAIN_E2E_TEST:      "xchain-e2e-test"
}

const REGTEST_MODULES = [
    XChainService.XCHAIN_REGTEST_MINER,
    XChainService.XCHAIN_E2E_TEST
]

const Coin = {
    BITCOIN:  "bitcoin",
    DOGECOIN: "dogecoin",
    LITECOIN: "litecoin"
}

const Network = {
    MAINNET: "mainnet",
    TESTNET: "testnet",
    REGTEST: "regtest"
}

const CoinTickerSymbol = {
    "bitcoin":  "BTC",
    "dogecoin": "DOGE",
    "litecoin": "LTC"
}

// --- Project folder names (used for paths inside containers) ---
const projectFolders = {
    "xchain-encoder":       "XChainEncoder",
    "xchain-decoder":       "XChainDecoder",
    "xchain-utxo-tracker":  "XChainUtxoTracker",
    "xchain-regtest-miner": "XChainRegtestMiner",
    "xchain-indexer":       "XChainIndexer",
    "xchain-hub":           "XChainHub",
    "xchain-explorer":      "XChainExplorer",
    "xchain-e2e-test":      "XChainE2ETest",
    "xchain-indexer-sync":  "XChainIndexerSync"
}

// --- Module Git URLs ---
const modulesUrls = {
    "xchain-encoder":       "git@github.com:XChain-platform/xchain-encoder.git",
    "xchain-decoder":       "git@github.com:XChain-platform/xchain-decoder.git",
    "xchain-utxo-tracker":  "git@github.com:XChain-platform/xchain-utxo-tracker.git",
    "xchain-indexer":       "git@github.com:XChain-platform/xchain-indexer.git",
    "xchain-regtest-miner": "git@github.com:XChain-platform/xchain-regtest-miner.git",
    "xchain-hub":           "git@github.com:XChain-platform/xchain-hub.git",
    "xchain-explorer":      "git@github.com:XChain-platform/xchain-explorer.git",
    "xchain-e2e-test":      "git@github.com:XChain-platform/xchain-e2e-test.git",
    "xchain-indexer-sync":  "git@github.com:XChain-platform/xchain-indexer-sync.git"
}

// --- Directory paths ---
const moduleDir          = path.join(__dirname, "..", "..", "modules")
const tmpDir             = path.join(__dirname, "..", "..", "tmp")
const srcDir             = path.join(__dirname, "..")
const cryptoNodesDir     = path.join(__dirname, "..", "..", "crypto_nodes")
const dataDir            = path.join(__dirname, "..", "..", "data")
const configDir          = path.join(__dirname, "..", "..", "config")
const containersFilesDir = path.join(tmpDir, "containers_files")

module.exports = {
    NODE_PREFIX,
    DB_NAME,
    NODE_MODULE_NAME,
    DB_MODULE_NAME,
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    INDEXER_SYNC_MODULE_NAME,
    NODE_VERSION_FILE_NAME,
    SEP,
    DB_SEP,
    HUB_PORT,
    XChainService,
    REGTEST_MODULES,
    Coin,
    Network,
    CoinTickerSymbol,
    projectFolders,
    modulesUrls,
    moduleDir,
    tmpDir,
    srcDir,
    cryptoNodesDir,
    dataDir,
    configDir,
    containersFilesDir
}
