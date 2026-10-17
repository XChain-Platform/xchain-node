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
const { scopedNodePrefixSegment } = require('../utils/module_database_name')
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
const paths = require('./config_service/paths')
const naming = require('./config_service/naming')
const { validatePort } = require('./config_service/validation')

paths.configure({ fs, moduleDir, tmpDir, cryptoNodesDir, Coin, stringToCoin })
naming.configure({
    NODE_PREFIX, DEFAULT_NODE_PREFIX, SEP, DB_SEP,
    DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    CoinTickerSymbol, Network, XChainService, scopedNodePrefixSegment
})

const {
    getModuleDir, getModuleTmpDir, getCryptoNodeDir, removeModuleDir,
    removeModuleTmpDir, createModuleTmpDir, moduleDirExists,
    checkIfModuleExists, checkIfCryptoNodeSourceExists
} = paths
const {
    getDockerContainerImageNamePrefix, getDockerContainerImageName,
    getUtxoTrackerVolumeName, getDockerNetwork, getModuleDatabaseName,
    applyPrefixedModuleDbUsers
} = naming

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
        defaultValues = defaults.createCoinDefaults(module, coin, network); applyPrefixedModuleDbUsers(defaultValues, coin, network); coins.applyCoinDefaults(defaultValues, module, coin, network)
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
