/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
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
    NODE_PREFIX, DEFAULT_NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, cryptoNodesDir, bootstrapDir, configDir, EXTERNAL_DB
} = require('../config')
const { stringToCoin } = require('../utils/helpers')
const { preferredSecretEnvName, foldSecretEnvAliases, readSecretHostEnv, deprecatedSecretEnvNames } = require('../config/secret_env')
const { getCoinConfigByFullName } = require('../coins')
const config = require('../config')
// Destructured where they are used, so each call reads the export at that moment.
const releaseManifestService = require('./release_manifest_service')
const stateModule = require('../state')
const peers = require('./peer_services').bindPeerServices(require)
const { getLogger } = require('../observability/logger')
const logger = getLogger()

const defaults = require('./config_service/defaults')
const coins = require('./config_service/coins')
const services = require('./config_service/services')
const sidecars = require('./config_service/sidecars')
const database = require('./config_service/database')
const networks = require('./config_service/networks')
const filters = require('./config_service/filters')
const argumentsService = require('./config_service/arguments')
const { validatePort } = require('./config_service/validation')

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

function getDockerContainerImageNamePrefix(module, coin, network) {
    if (module === DB_MODULE_NAME || module === HUB_MODULE_NAME || module === EXPLORER_MODULE_NAME || module === SYNC_MODULE_NAME) {
        return NODE_PREFIX
    }
    return NODE_PREFIX + SEP + coin + SEP + network
}

function getDockerContainerImageName(module, coin, network) {
    return getDockerContainerImageNamePrefix(module, coin, network) + SEP + module
}

// Single source of truth for the UTXO tracker's Docker volume name. Two
// NODE_PREFIX stacks of the same coin+network must not share one volume, so
// non-default prefixes get a prefixed volume name; the default prefix keeps
// the legacy unprefixed name (renaming it would orphan every existing
// deployment's tracker data, forcing a fleet-wide resync). Previously this
// rule lived only in ModuleService.buildAndUp; moduleOperations.resetModules
// and all three BootstrapService sites re-derived the unprefixed name
// independently, so a non-default NODE_PREFIX made reset/bootstrap/restore
// silently operate on the wrong stack's volume (uuid:7523dd94, uuid:a61fc673).
function getUtxoTrackerVolumeName(coin, network) {
    const prefix = NODE_PREFIX === DEFAULT_NODE_PREFIX ? '' : `${NODE_PREFIX}${SEP}`
    return `${prefix}${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${coin}-${network}-data`
}

function getDockerNetwork(coin, network) {
    return NODE_PREFIX
        + (coin   !== "" ? SEP + coin    : "")
        + (network !== "" ? SEP + network : "")
}

function getModuleDatabaseName(module, coin, network) {
    // Defense in depth: an unknown coin (e.g. 'all' or a typo passed straight
    // from a raw CLI arg) yields CoinTickerSymbol[coin] === undefined, which
    // would otherwise produce a junk `XChain_undefined_*` name that reaches
    // CREATE DATABASE on the live MariaDB while the command still exits 0.
    // Fail loud so an unresolved coin never materializes a database.
    if (coin !== "" && CoinTickerSymbol[coin] === undefined) {
        throw new Error("Unknown coin '" + coin + "'; cannot derive a database name")
    }
    // Mirror the coin guard above: a typo'd network (e.g. from a raw CLI arg
    // on the reset/bootstrap paths, which bypass filterCommandParameters)
    // would otherwise derive a well-formed-but-bogus name that still reaches
    // CREATE DATABASE while the command exits 0.
    if (network !== "" && !Object.values(Network).includes(network)) {
        throw new Error("Unknown network '" + network + "'; cannot derive a database name")
    }
    const moduleName = module.slice("xchain-".length)
    return "XChain" + DB_SEP
        + CoinTickerSymbol[coin] + DB_SEP
        + network.charAt(0).toUpperCase() + network.slice(1) + DB_SEP
        + moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
}

sidecars.configure({
    crypto, fs, path, readline, configDir, preferredSecretEnvName,
    foldSecretEnvAliases, deprecatedSecretEnvNames, logger
})
database.configure({ crypto, EXTERNAL_DB, SEP, XChainService, peers, sidecars })
networks.configure({
    stateModule, Coin, Network, XChainService, logger, config, peers, readSecretHostEnv,
    HUB_MODULE_NAME, getDockerContainerImageName
})
defaults.configure({
    config, Network, Coin, CoinTickerSymbol, XChainService, DB_SEP, SEP, bootstrapDir,
    NODE_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    getDockerContainerImageName, getModuleDatabaseName
})
coins.configure({ config, CoinTickerSymbol, Network, XChainService, getCoinConfigByFullName, getDockerContainerImageName })
services.configure({
    config, peers, logger, readSecretHostEnv, Coin, Network, CoinTickerSymbol, XChainService,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, getDockerContainerImageName
})
filters.configure({
    Coin, Network, XChainService, REGTEST_MODULES,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME
})
argumentsService.configure({
    Coin, Network, XChainService, NODE_MODULE_NAME, DB_MODULE_NAME,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    releaseManifestService, serviceAliases: filters.serviceAliases
})

const {
    persistSidecarCreds, upsertSidecarValues, readSidecarValue,
    ensureHubApiKey, applyHubApiKeyFromSidecar, readHubApiKey
} = sidecars
const { filterCommandParameters } = filters
const { resolveArgs } = argumentsService

async function getDefaultConfig(module, coin, network) {
    let defaultValues; if (coin && network) {
        defaultValues = defaults.createCoinDefaults(module, coin, network); coins.applyCoinDefaults(defaultValues, module, coin, network)
        services.configureE2e(defaultValues, module, coin)
        if (module === XChainService.XCHAIN_E2E_TEST) await applyHubApiKeyFromSidecar(defaultValues)
        services.configureIndexerBeforeHubKey(defaultValues, module, network)
        if (module === XChainService.XCHAIN_INDEXER) await applyHubApiKeyFromSidecar(defaultValues)
        services.configureIndexerAfterHubKey(defaultValues, module, network)
    } else {
        defaultValues = defaults.createSharedDefaults(); defaults.configureSharedBeforeHubKey(defaultValues)
        await applyHubApiKeyFromSidecar(defaultValues)
        defaults.configureSharedAfterHubKey(defaultValues, module)
    }
    networks.configureHubBeforeKey(defaultValues, module)
    if (module === HUB_MODULE_NAME) {
        await applyHubApiKeyFromSidecar(defaultValues)
        networks.configureHubAccess(defaultValues)
        if (!defaultValues["HUB_NETWORK"]) {
            const deploymentNetwork = await networks.resolveDeploymentHubNetwork(); if (deploymentNetwork) defaultValues["HUB_NETWORK"] = deploymentNetwork
        }
        if (!defaultValues["BTC_INDEXER_API_URL"] && defaultValues["HUB_NETWORK"]) {
            const btcNetwork = String(defaultValues["HUB_NETWORK"]).toLowerCase()
            if (await networks.hasBitcoinIndexer(btcNetwork)) {
                defaultValues["BTC_INDEXER_API_URL"] = "http://" + getDockerContainerImageName(XChainService.XCHAIN_INDEXER, Coin.BITCOIN, btcNetwork) + ":3004"
            } else {
                networks.warnHubConfigOnce("BTC_INDEXER_MISSING", "WARNING: this hub has no BTC indexer (BTC_INDEXER_API_URL is not set in the host env and this deployment runs no bitcoin " + btcNetwork + " stack), so it cannot read capability snapshots: every on-chain PRICE batch its indexer parses is recorded invalid for insufficient signer stake. Install a bitcoin " + btcNetwork + " stack, or set BTC_INDEXER_API_URL to a reachable BTC indexer.")
            }
        }
        networks.configureHubValidator(defaultValues)
    }
    const defaultConfig = {}
    if (coin && network && coin !== "" && network !== "") {
        const { configFilePath, localFilePath } = sidecars.coinConfigPaths(coin, network)
        let mainFileHasCreds = false
        if (!fs.existsSync(configFilePath)) logger.warn("Warning: config file not found: " + configFilePath + " (using defaults)")
        else { const rl = readline.createInterface({ input: fs.createReadStream(configFilePath), crlfDelay: Infinity })
            for await (const line of rl) mainFileHasCreds = sidecars.readMainConfigLine(defaultConfig, line) || mainFileHasCreds
        }
        sidecars.normalizeMainConfig(defaultConfig, configFilePath)
        if (fs.existsSync(localFilePath)) {
            const sidecarConfig = {}
            const rlLocal = readline.createInterface({ input: fs.createReadStream(localFilePath), crlfDelay: Infinity })
            for await (const line of rlLocal) sidecars.readSidecarConfigLine(sidecarConfig, line)
            sidecars.mergeSidecarConfig(defaultConfig, sidecarConfig, localFilePath)
        }
        if (mainFileHasCreds) sidecars.migrateMainCredentials(defaultConfig, configFilePath, localFilePath)
        sidecars.generateRpcCredentials(defaultConfig, localFilePath)
        if (await database.dbPasswordCanRotate()) database.generateDatabaseCredentials(defaultConfig, localFilePath)
        database.setIndexerHubPassword(defaultConfig, defaultValues, module)
    }
    if (("HUB_DB_PASS" in defaultValues) && !("HUB_DB_PASS" in defaultConfig)) {
        defaultConfig["HUB_DB_PASS"] = await database.getOrCreateHubDbPass()
    }
    database.mergeDefaults(defaultConfig, defaultValues)
    if (EXTERNAL_DB) {
        const externalConfig = await peers.databaseService.getExternalDbConfig()
        database.applyExternalDatabase(defaultConfig, externalConfig)
    }
    return defaultConfig
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
    getUtxoTrackerVolumeName,
    getDockerNetwork,
    getModuleDatabaseName,
    validatePort,
    getDefaultConfig,
    persistSidecarCreds,
    upsertSidecarValues,
    readSidecarValue,
    ensureHubApiKey,
    applyHubApiKeyFromSidecar,
    readHubApiKey,
    filterCommandParameters,
    resolveArgs
}
