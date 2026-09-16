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
 * XChain Node - Node Service
 * Download, build and install cryptocurrency nodes
 ********************************************************************/

const {
    NODE_MODULE_NAME, SEP, Network, XChainService
} = require('../config')
const {
    nodeStopTimeoutSeconds,
    describeNodeStopOutcome,
    DEFAULT_NODE_STOP_TIMEOUT_SECONDS
} = require('./node_service/node_stop.js')

const { getRemoteModuleVersions } = require('../state')
const { getCryptoNode } = require('./node_service/crypto_node_download.js')
const {
    buildCryptoNode,
    stageBuildScaffold,
    resolveBlocksDir
} = require('./node_service/crypto_node_build.js')
const { statusChanged }                 = require('./status_service')
const { checkRemoteNodeVersion }        = require('./version_service')
const config = require('../config');
// Destructured where they are used, so each call reads the export at that moment.
const dockerService = require('./docker_service')
const configService = require('./config_service')
const databaseService = require('./database_service')
const versionService = require('./version_service')
const peers = require('./peer_services').bindPeerServices(require)
const { getLogger } = require('../observability/logger');
const logger = getLogger();

// Optional exact-version pin for a coin daemon, read from
// XCHAIN_NODE_NODE_VERSION_<COIN> (e.g. XCHAIN_NODE_NODE_VERSION_LITECOIN=v0.21.4).
// Test harnesses (notably the multi-chain parity sweep) set this so the
// installed daemon matches the DEPLOYED fleet image instead of drifting to the
// latest upstream release. Returns null when no pin is set.
function resolveNodeVersionPin(coin) {
    const pin = config.NODE_VERSION_PIN_ENV['XCHAIN_NODE_NODE_VERSION_' + String(coin).toUpperCase()]
    return pin && pin.trim() !== '' ? pin.trim() : null
}

// Enforce a version pin against an already-installed local daemon. A silent
// mismatch would defeat the pin (installNode skips the download when a local
// copy exists), so fail loudly with the remediation instead.
function assertNodeVersionPin(coin, network, localNodeVersion, pin) {
    if (pin && localNodeVersion != null && localNodeVersion !== pin) {
        throw new Error(
            `Installed ${coin} node is ${localNodeVersion} but ` +
            `XCHAIN_NODE_NODE_VERSION_${String(coin).toUpperCase()} pins ${pin}. ` +
            `Remove the ${coin}/${network} stack (or the cached crypto node) and reinstall.`)
    }
}

async function installDependentServices(coin, network, cloneGit, buildAndUp) {
    logger.info("Downloading xchain-encoder...")
    await cloneGit(XChainService.XCHAIN_ENCODER, true)
    logger.info("Building xchain-encoder container...")
    await buildAndUp(XChainService.XCHAIN_ENCODER, coin, network)

    logger.info("Downloading xchain-decoder...")
    await cloneGit(XChainService.XCHAIN_DECODER, true)
    logger.info("Building xchain-decoder container...")
    await buildAndUp(XChainService.XCHAIN_DECODER, coin, network)

    logger.info("Downloading xchain-utxo-tracker...")
    await cloneGit(XChainService.XCHAIN_UTXO_TRACKER, true)
    logger.info("Building xchain-utxo-tracker...")
    // Only a CONFIRMED empty volume authorises the restore below; an inspection
    // that failed is not evidence of emptiness.
    const { utxoTrackerVolumeFreshness, ensureBootstrapUtxoTracker, forceBootstrapRequested,
        FRESHNESS_EMPTY } = require('./bootstrap_service')
    const utxoWasFresh = (await utxoTrackerVolumeFreshness(coin, network)) === FRESHNESS_EMPTY
        || forceBootstrapRequested()
    await buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (utxoWasFresh) await ensureBootstrapUtxoTracker(coin, network)

    if (network === Network.REGTEST) {
        logger.info("Downloading xchain-regtest-miner...")
        await cloneGit(XChainService.XCHAIN_REGTEST_MINER, true)
        logger.info("Building xchain-regtest-miner...")
        await buildAndUp(XChainService.XCHAIN_REGTEST_MINER, coin, network)
    }

    logger.info("Downloading xchain-indexer...")
    await cloneGit(XChainService.XCHAIN_INDEXER, true)
    logger.info("Building xchain-indexer...")
    await buildAndUp(XChainService.XCHAIN_INDEXER, coin, network)
}

async function setInstalledDatabaseParameters() {
    try {
        const { setDatabaseParameters } = databaseService
        await setDatabaseParameters()
    } catch (e) {
        // setDatabaseParameters is the ONLY step that force-sets the live decoder/indexer
        // MariaDB accounts to the per-install passwords getDefaultConfig just minted and
        // baked into the container env. If it fails, both containers are already up with a
        // password that exists nowhere in the DB (ER_ACCESS_DENIED crash-loop), so the
        // install has NOT succeeded. Fail loudly (matching installNode's throw-on-error
        // convention) rather than logging a warning and returning true.
        throw new Error("Node install failed: could not set database parameters, so the decoder/indexer would be locked out of MariaDB: " + (e && e.message ? e.message : e))
    }
}

async function installNode(coin, network) {
    logger.info("Creating xchain docker network...")
    const { createDockerNetwork } = dockerService
    const { getDockerNetwork } = configService
    await createDockerNetwork(getDockerNetwork(coin, network))

    logger.info("Installing database...")
    const { buildDatabaseModule } = databaseService
    await buildDatabaseModule(coin, network)

    logger.info("Installing " + coin + " " + network + " node...")
    const { getLocalNodeVersion } = versionService
    let localNodeVersion = null
    try {
        localNodeVersion = await getLocalNodeVersion(coin, network)
    } catch { /* not installed */ }

    const versionPin = resolveNodeVersionPin(coin)
    assertNodeVersionPin(coin, network, localNodeVersion, versionPin)

    if (localNodeVersion == null) {
        if (versionPin) {
            logger.info("Node version pinned via env: installing " + coin + " " + versionPin)
            await getCryptoNode(coin, network, versionPin)
        } else {
            if (!(NODE_MODULE_NAME + SEP + coin in getRemoteModuleVersions())) {
                await checkRemoteNodeVersion(coin)
            }
            const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
            if (remoteNodeVersion != null) {
                await getCryptoNode(coin, network, remoteNodeVersion)
            } else {
                throw new Error("There is no valid version to download for the " + coin + "/" + network + " node")
            }
        }
    }
    await buildCryptoNode(coin, network)

    const { cloneGit, buildAndUp } = peers.moduleService
    await installDependentServices(coin, network, cloneGit, buildAndUp)
    await setInstalledDatabaseParameters()

    await statusChanged()
    return true
}

module.exports = {
    getCryptoNode,
    buildCryptoNode,
    stageBuildScaffold,
    installNode,
    resolveBlocksDir,
    resolveNodeVersionPin,
    assertNodeVersionPin,
    nodeStopTimeoutSeconds,
    describeNodeStopOutcome,
    DEFAULT_NODE_STOP_TIMEOUT_SECONDS
}
