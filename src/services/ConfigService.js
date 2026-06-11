/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Config Service
 * Path helpers, naming helpers, and getDefaultConfig
 ********************************************************************/

const crypto   = require('crypto')
const fs       = require('fs')
const path     = require('path')
const readline = require('readline')

const {
    NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, cryptoNodesDir, dataDir, configDir,
    EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT
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
    if (module === DB_MODULE_NAME || module === HUB_MODULE_NAME || module === EXPLORER_MODULE_NAME || module === SYNC_MODULE_NAME) {
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

// --- Validation helpers ---

function validatePort(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 1 && value <= 65535
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const port = parseInt(value, 10)
        return port >= 1 && port <= 65535
    }
    return false
}

// --- Default config ---

// Persist RPC credentials to the untracked <coin>-<network>.local sidecar. A fresh sidecar
// is created with writeFileSync; an existing one is appended to, unless overwrite is set
// (used by the legacy-migration path to replace it outright).
function persistSidecarCreds(localFilePath, creds, { overwrite = false } = {}) {
    const body = Object.keys(creds).map(k => `${k}=${creds[k]}`).join("\n") + "\n"
    if (overwrite || !fs.existsSync(localFilePath)) {
        const dir = path.dirname(localFilePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(localFilePath, body)
    } else {
        fs.appendFileSync(localFilePath, body)
    }
}

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
            "INDEXER_BOOTSTRAP_VOLUME": dataDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
            "ENCODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_ENCODER, coin, network),
            "ENCODER_API_PORT":  3003,
            "ENCODER_PORT":      3003,
            "INDEXER_URL":       getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_API_PORT":  3004,
            "INDEXER_PORT":      3004,
            "INDEXER_COIN":      CoinTickerSymbol[coin],
            "INDEXER_NETWORK":   network,
            "INDEXER_DB_HOST":   "mariadb",
            "INDEXER_DB_PORT":   3306,
            "INDEXER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_DB_USER":   "xchain" + DB_SEP + "indexer" + DB_SEP + coin + DB_SEP + network,
            "INDEXER_DB_PASS":   "xchain" + SEP + "password",
            // The e2e-test harness reaches the indexer DB via DATABASE_URL/DATABASE_PORT
            // (test/initialCheck.test.js), not INDEXER_DB_HOST/PORT. Default them here so
            // the EXTERNAL_DB rewrite below can repoint them — on a host-native-DB box the
            // docker DNS name "mariadb" doesn't resolve and the suite fails at bootstrap.
            "DATABASE_URL":      "mariadb",
            "DATABASE_PORT":     3306,
            "HUB_HOST":          "0.0.0.0",
            "HUB_API_HOST":      getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":          10000,
            // The e2e federation suites (test:federation / test:attestation:llm) boot
            // in-process MultiValidatorHubs that create + drop XChain_<coin>_<net>_MVH_*
            // databases, so the container needs the hub DB credentials. DatabaseService
            // grants this user CREATE/DROP on the XChain_%_MVH_% pattern when the hub
            // module is installed. Omitting these made requireFederationEnv loud-fail.
            "HUB_DB_HOST":       "mariadb",
            "HUB_DB_PORT":       3306,
            "HUB_DB_USER":       "xchain" + DB_SEP + "hub",
            "HUB_DB_PASS":       "xchain" + SEP + "password",
            // Explorer is a SHARED service (no coin/network suffix). Like the hub
            // above, the e2e-test container needs to reach it on the docker network;
            // omitting it left EXPLORER_URL/EXPLORER_API_PORT unset, which failed the
            // e2e harness's checkAllEnvironmentalVariables() → broken hub-config fallback.
            "EXPLORER_URL":      getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
            "EXPLORER_API_PORT": 8080,
            "EXPLORER_PORT":     8080
        }

        if (network === "regtest") {
            defaultValues["REGTEST_MINER_URL"]      = getDockerContainerImageName(XChainService.XCHAIN_REGTEST_MINER, coin, network)
            defaultValues["REGTEST_MINER_API_PORT"] = 3005
            defaultValues["REGTEST_MINER_PORT"]     = 3005
            // Encoder's express-rate-limit defaults to 60 RPM, which the e2e
            // suite blows past whenever the stale-UTXO retry shim fires (up
            // to 15 retries per failing tx — easily 100+ RPM during the
            // order/swap blocks). Production-safe defaults stay at 60; we
            // raise it for regtest where load is by-design bursty.
            defaultValues["ENCODER_RATE_LIMIT_RPM"] = 99999
        }

        // Native-coin protocol fee destination (per coin/network). Read from the host env
        // (e.g. xchain-node's .env) so the protocol fee address stays out of source — mirrors
        // the TELEMETRY_IP_SALT injection pattern above. The decoder reads FEE_DESTINATION (to
        // persist the fee output to transaction_outputs); the indexer reads
        // XCHAIN_FEE_DESTINATION_<COIN>_<NETWORK> (src/configs/<COIN>.js). Injected as a default,
        // so a value in the <coin>-<network> config file still takes precedence; when unset,
        // native-coin fee payment stays disabled (config placeholder).
        const feeDestEnvName = 'XCHAIN_FEE_DESTINATION_' + CoinTickerSymbol[coin] + '_' + network.toUpperCase()
        const feeDestination = process.env[feeDestEnvName] || process.env.FEE_DESTINATION || null
        if (feeDestination) {
            defaultValues['FEE_DESTINATION'] = feeDestination
            defaultValues[feeDestEnvName]    = feeDestination
        }

        // Address-deriving modules (encoder/decoder/utxo-tracker) resolve their bitcoinjs
        // network via CryptoNetworks, which keys on the COIN-PREFIXED name (e.g.
        // "bitcoin-regtest"). A bare network ("regtest") matches no case → getBitcoinJsNetwork
        // returns undefined → bitcoinjs-lib falls back to MAINNET → addresses derive with
        // mainnet version bytes (a regtest "m..."/"n..." source comes out as "1..."), which then
        // never matches on-chain balances (e.g. an issuance fee-check reads the wrong address and
        // fails "insufficient funds (FEE)"). Those modules need the coin-prefixed network; the
        // indexer/node keep the bare network (protocol-change matching / bitcoind conf).
        if (module === XChainService.XCHAIN_ENCODER || module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_UTXO_TRACKER) {
            defaultValues["NETWORK"] = coin + "-" + network
        }
    } else {
        defaultValues = {
            "HUB_HOST":              "0.0.0.0",
            "HUB_API_HOST":          getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":              10000,
            "HUB_DB_HOST":           "mariadb",
            "HUB_DB_PORT":           3306,
            "HUB_DB_NAME":           "XChain" + DB_SEP + "Hub",
            "HUB_DB_USER":           "xchain" + DB_SEP + "hub",
            "HUB_DB_PASS":           "xchain" + SEP + "password",
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
            "SYNC_API_HOST":           getDockerContainerImageName(SYNC_MODULE_NAME, "", ""),
            "HUB_API_HOST_SYNC":       getDockerContainerImageName(HUB_MODULE_NAME, "", "")
        }
    }

    // Usage-telemetry env is only meaningful to the hub (the telemetry collector).
    // TELEMETRY_IP_SALT is read from the host environment (e.g. xchain-node's .env) so
    // the IP-hash salt stays out of source and config files; without it the hub records
    // country/region but leaves ip_hash null. The hub is a shared service (no per
    // coin/network config file), so the host env is the injection point.
    if (module === HUB_MODULE_NAME) {
        defaultValues["TELEMETRY_ENABLED"]        = process.env.TELEMETRY_ENABLED || "true"
        defaultValues["TELEMETRY_RETENTION_DAYS"] = process.env.TELEMETRY_RETENTION_DAYS || 90
        defaultValues["TELEMETRY_IP_SALT"]        = process.env.TELEMETRY_IP_SALT || ""
        // Gate for the per-install detail endpoint (GET /telemetry/operators). Like the
        // salt, sourced from host env so the secret stays out of source/config files;
        // unset leaves the endpoint fail-closed (401 for everyone).
        defaultValues["TELEMETRY_ADMIN_KEY"]      = process.env.TELEMETRY_ADMIN_KEY || ""

        // BTC indexer JSON-RPC URL for the validator-mode price oracle's block-height
        // anchor (hub.getlatestblock). Sourced from host env so a hub NOT co-located with
        // a BTC indexer (e.g. the master hub box, where the BTC stack lives elsewhere) can
        // point at a reachable indexer. Empty default ⇒ the hub falls back to its configs
        // table, so co-located standalone/validator installs are unaffected.
        defaultValues["BTC_INDEXER_API_URL"]      = process.env.BTC_INDEXER_API_URL || ""

        // State-checkpoint engine + ANCHOR publisher (validator mode). The hub is a
        // shared service (no per coin/network config file), so — like the telemetry
        // salt and BTC_INDEXER_API_URL above — the host env is the injection point.
        // Per-coin <COIN>_INDEXER_URLs feed getblockhashes (checkpoint state reads);
        // DOGE_* configures the on-chain ANCHOR/price publisher signer pipeline;
        // XDEX_* are the shared single-validator/regtest seams. Only set values are
        // injected, so unset host env leaves the hub's own defaults untouched.
        const hubPassthroughVars = [
            "BTC_INDEXER_URL", "LTC_INDEXER_URL", "DOGE_INDEXER_URL",
            "BTC_INDEXER_API_KEY", "LTC_INDEXER_API_KEY", "DOGE_INDEXER_API_KEY",
            "CHECKPOINT_ENABLED", "CHECKPOINT_INTERVAL_BLOCKS", "CHECKPOINT_CONFIRMATIONS",
            "CHECKPOINT_POLL_MS", "CHECKPOINT_ROUND_TIMEOUT_MS", "CHECKPOINT_CHAINS",
            "ANCHOR_ENABLED", "ANCHOR_INTERVAL_MS", "ANCHOR_MATCH_BATCH_SIZE",
            "ANCHOR_MAX_BATCH", "ANCHOR_CHUNK_MAX_BYTES", "ANCHOR_ROUND_TIMEOUT_MS",
            "ANCHOR_ELECTION_TOLERANCE_BLOCKS", "ANCHOR_REWARD_PER_PUBLISH",
            "DOGE_ENCODER_URL", "DOGE_ENCODER_API_KEY", "DOGE_ADDRESS",
            "DOGE_PUBKEY_HEX", "DOGE_LOW_BALANCE_THRESHOLD",
            "XDEX_SEED_LOCAL_VALIDATOR", "XDEX_SNAPSHOT_BLOCK"
        ]
        for (const varName of hubPassthroughVars) {
            if (process.env[varName] !== undefined && process.env[varName] !== "") {
                defaultValues[varName] = process.env[varName]
            }
        }

        // Operator signer for the on-chain DOGE publishers: when the host sets
        // XCHAIN_NODE_HUB_SIGNER_DIR, ModuleService mounts that directory
        // read-only at /XChainHub/operator-signer and the hub loads
        // <dir>/signer.js via HUB_SIGNER_MODULE (see xchain-hub
        // examples/doge-signer.example.js for the module contract).
        if (process.env.XCHAIN_NODE_HUB_SIGNER_DIR) {
            defaultValues["HUB_SIGNER_MODULE"] = "/XChainHub/operator-signer/signer.js"
        }

        // Validator mode: when `xchain-node validator init` has been run, inject the
        // P2P / signing-key / capability-config env so the hub starts as a full
        // validator. Returns {} (no change) for a standalone node, so the standalone
        // install path is unaffected.
        const { getValidatorEnv } = require('./ValidatorService')
        Object.assign(defaultValues, getValidatorEnv())
    }

    // Read the config file for this coin/network pair. Non-secret operator overrides live
    // in the main config file; runtime RPC credentials live in a separate, untracked
    // <coin>-<network>.local sidecar so the main file can be diffed/shared without ever
    // carrying rpcuser/rpcpassword.
    const defaultConfig = {}
    if (coin && network && coin !== "" && network !== "") {
        const configFilePath = path.resolve(configDir, `${coin}-${network}`)
        if (!configFilePath.startsWith(path.resolve(configDir) + path.sep) && configFilePath !== path.resolve(configDir)) {
            throw new Error('Config path traversal detected')
        }
        const localFilePath = configFilePath + ".local"

        // Track whether the main file still carries credentials so legacy installs can be migrated.
        let mainFileHasCreds = false

        if (!fs.existsSync(configFilePath)) {
            console.warn("Warning: config file not found: " + configFilePath + " — using defaults")
        } else {
            const configFileStream = fs.createReadStream(configFilePath)
            const rl = readline.createInterface({ input: configFileStream, crlfDelay: Infinity })
            for await (const line of rl) {
                const eqIndex = line.indexOf("=")
                if (eqIndex > 0) {
                    const key = line.substring(0, eqIndex)
                    defaultConfig[key] = line.substring(eqIndex + 1)
                    if (key === "NODE_USER" || key === "NODE_PASSWORD") mainFileHasCreds = true
                }
            }
        }

        // Credentials from the sidecar take precedence over anything in the main file.
        if (fs.existsSync(localFilePath)) {
            const localStream = fs.createReadStream(localFilePath)
            const rlLocal = readline.createInterface({ input: localStream, crlfDelay: Infinity })
            for await (const line of rlLocal) {
                const eqIndex = line.indexOf("=")
                if (eqIndex > 0) {
                    defaultConfig[line.substring(0, eqIndex)] = line.substring(eqIndex + 1)
                }
            }
        }

        // One-time migration for legacy installs: older versions appended NODE_USER /
        // NODE_PASSWORD into the main config file alongside non-secret settings. Move the
        // credentials into the sidecar and strip them from the main file so the two never
        // share a file again. Existing creds keep working — they are simply relocated.
        if (mainFileHasCreds) {
            const creds = {}
            if ("NODE_USER" in defaultConfig)     creds["NODE_USER"]     = defaultConfig["NODE_USER"]
            if ("NODE_PASSWORD" in defaultConfig) creds["NODE_PASSWORD"] = defaultConfig["NODE_PASSWORD"]
            persistSidecarCreds(localFilePath, creds, { overwrite: true })
            const remaining = []
            for (const key in defaultConfig) {
                if (key !== "NODE_USER" && key !== "NODE_PASSWORD") remaining.push(`${key}=${defaultConfig[key]}`)
            }
            fs.writeFileSync(configFilePath, remaining.length ? remaining.join("\n") + "\n" : "")
        }

        // Generate and persist RPC credentials to the sidecar on first provision if absent everywhere.
        if (!("NODE_USER" in defaultConfig) && !("NODE_PASSWORD" in defaultConfig)) {
            const nodeUser     = crypto.randomBytes(12).toString('hex')
            const nodePassword = crypto.randomBytes(24).toString('hex')
            defaultConfig["NODE_USER"]     = nodeUser
            defaultConfig["NODE_PASSWORD"] = nodePassword
            persistSidecarCreds(localFilePath, { NODE_USER: nodeUser, NODE_PASSWORD: nodePassword })
        }
    }

    for (const key in defaultValues) {
        if (!(key in defaultConfig)) {
            defaultConfig[key] = defaultValues[key]
        }
    }

    // EXTERNAL_DB: rewrite the DB host/port keys so containerized services
    // reach the host-native MariaDB via the bridge gateway instead of the
    // docker DNS name "mariadb" (which no longer resolves once the bundled
    // container is decommissioned). The DB name/user/pass keys stay as-is —
    // those are about the credentials, not the network location.
    if (EXTERNAL_DB) {
        const dbHostKeys = ['HUB_DB_HOST', 'DECODER_DB_HOST', 'INDEXER_DB_HOST', 'DATABASE_URL']
        const dbPortKeys = ['HUB_DB_PORT', 'DECODER_DB_PORT', 'INDEXER_DB_PORT', 'DATABASE_PORT']
        for (const k of dbHostKeys) {
            if (k in defaultConfig) defaultConfig[k] = EXTERNAL_DB_HOST
        }
        for (const k of dbPortKeys) {
            if (k in defaultConfig) defaultConfig[k] = EXTERNAL_DB_PORT
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

    // Shared services (hub / explorer / db / sync) are registered under a single
    // empty coin+network key, not per-coin. A bare `update xchain-hub` must resolve
    // to that ""/"" container; otherwise it gets fanned out across real coins where
    // it matches nothing and the command silently no-ops.
    const SHARED_SERVICES = [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, DB_MODULE_NAME, SYNC_MODULE_NAME]

    if (modules === "all") {
        modules = Object.values(XChainService).filter(m => m !== XChainService.XCHAIN_E2E_TEST)
        modules.push(NODE_MODULE_NAME)
        addExplorer = true
    } else if (modules === "explorer") {
        addExplorer = true
        coins = []
    } else if (SHARED_SERVICES.includes(modules)) {
        // Explicitly-named shared service → emit under the empty ""/"" key only.
        return { "": { "": [modules] } }
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

// --- Argument resolution (order-independent) ---

function resolveArgs(args, { expectBranch = false, defaultBranch = 'master' } = {}) {
    let service = 'all', chain = 'all', network = 'all', branch = null

    const knownServices = [
        ...Object.values(XChainService),
        NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME,
        EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, 'explorer'
    ]
    const knownChains   = Object.values(Coin)
    const knownNetworks = Object.values(Network)

    for (const arg of args) {
        if (!arg || arg === 'all') continue

        if (knownChains.includes(arg)) {
            chain = arg
        } else if (knownNetworks.includes(arg)) {
            network = arg
        } else if (knownServices.includes(arg)) {
            service = arg
        } else if (expectBranch && !branch) {
            branch = arg
        }
    }

    if (expectBranch && !branch) branch = defaultBranch

    if (branch && !/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
        throw new Error("Invalid branch name: " + branch + " — branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes")
    }

    return { service, chain, network, branch }
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
    validatePort,
    getDefaultConfig,
    filterCommandParameters,
    resolveArgs
}
