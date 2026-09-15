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
 * XChain Node - Module Service
 * Clone, build, install and uninstall XChain modules
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const fs        = require('fs')
const path = require('path')
const {
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    XChainService, SEP, modulesUrls, LIBRARY_BUNDLES, SERVICE_REGISTRY, DEFAULT_MODULE_BRANCH,
    Coin, Network, DEPENDENCY_HEALTH_START_PERIOD
} = require('../config')
const { db }                = require('../state')
const {
    getModuleDir, getModuleTmpDir, moduleDirExists, checkIfModuleExists,
    removeModuleTmpDir, createModuleTmpDir,
    getDockerContainerImageName, getUtxoTrackerVolumeName, getDockerNetwork, getDefaultConfig, validatePort
} = require('./config_service')
const { statusChanged, getStatus } = require('./status_service')
const { stopContainerByName, removeContainer, getPublishedHostPorts, forceRemoveContainerByName, addContainerToNetwork, checkBuildKitAvailable } = require('./docker_service')
const { stopModuleContainer, stopTimeoutArgs } = require('./stop_budget_service')
const { setDatabaseParameters, setHubDatabaseParameters }  = require('./database_service')
const { redactSecrets, sleep } = require('../utils/helpers')
const config = require('../config');
// Destructured where they are used, so each call reads the export at that moment.
const goLiveGate             = require('./go_live_gate')
const memoryLimitService     = require('./memory_limit_service')
const releaseManifestService = require('./release_manifest_service')
const stateModule            = require('../state')
const validatorService       = require('./validator_service')
const hubConsensusEnvGuard   = require('./hub_consensus_env_guard')
const rollcallWiring         = require('./rollcall_wiring')
const versionService         = require('./version_service')
const nodeService            = require('./node_service')
const databaseService        = require('./database_service')
const dbCredentialDrift      = require('./db_credential_drift')
const bootstrapService       = require('./bootstrap_service')
const peers                  = require('./peer_services').bindPeerServices(require)
const { getLogger } = require('../observability/logger');
const logger = getLogger();

const { configureDependencies: configureGitCheckout, CLONE_STAGING_SUFFIX, CLONE_PREVIOUS_SUFFIX, runGitClone, assertCheckoutCommit, readCheckoutIdentity, readCheckoutIdentityFromDisk, readSourceBranchTip, isLocalPathSource, warnIfSourceBranchIsBehind, verifyDeploySource, reportDeployedSource } = require('./module_service/git_checkout.js')
const { configureDependencies: configureCloneAndRefs, cloneGit, getModuleBranch, getModuleCommit, resolveBundledLibRef } = require('./module_service/clone_and_refs.js')
const { configureDependencies: configureDockerArgs, SERVICE_HEALTHCHECK, resolveStartPeriod, OBSERVABILITY_ENV_KEYS, resolveObservabilityEnv, buildHealthcheckArgs, buildModuleDockerArgs, assertNoHostPortConflicts } = require('./module_service/docker_args.js')
const { configureDependencies: configureContainerNetworks, crossChainNetworksFor, attachCrossChainNetworks, verifyContainerMemoryLimit, logDockerCreateWarnings } = require('./module_service/container_networks.js')
const { configureDependencies: configureBuildAndUp, buildAndUp } = require('./module_service/build_and_up.js')

configureGitCheckout({ execFile, execFileAsync, fs, path, modulesUrls, redactSecrets, logger })
configureCloneAndRefs({ execFileAsync, fs, modulesUrls, DEFAULT_MODULE_BRANCH, getModuleDir, getModuleTmpDir, moduleDirExists, removeModuleTmpDir, createModuleTmpDir, redactSecrets, releaseManifestService, CLONE_STAGING_SUFFIX, CLONE_PREVIOUS_SUFFIX, runGitClone, assertCheckoutCommit, verifyDeploySource, reportDeployedSource, logger })
configureDockerArgs({ fs, path, XChainService, SERVICE_REGISTRY, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, DEPENDENCY_HEALTH_START_PERIOD, getUtxoTrackerVolumeName, getPublishedHostPorts, config, validatorService, logger })
configureContainerNetworks({ execFile, XChainService, Coin, Network, getDockerNetwork, getStatus, addContainerToNetwork, redactSecrets, sleep, memoryLimitService, logger })
configureBuildAndUp({ execFile, execFileAsync, fs, path, HUB_MODULE_NAME, LIBRARY_BUNDLES, db, getModuleDir, checkIfModuleExists, getDockerContainerImageName, getDockerNetwork, getDefaultConfig, validatePort, stopContainerByName, removeContainer, forceRemoveContainerByName, checkBuildKitAvailable, stopModuleContainer, stopTimeoutArgs, statusChanged, setHubDatabaseParameters, redactSecrets, config, goLiveGate, memoryLimitService, hubConsensusEnvGuard, rollcallWiring, readCheckoutIdentityFromDisk, cloneGit, resolveBundledLibRef, assertNoHostPortConflicts, resolveObservabilityEnv, buildHealthcheckArgs, buildModuleDockerArgs, attachCrossChainNetworks, verifyContainerMemoryLimit, logDockerCreateWarnings, logger })

for (const part of ['git_checkout', 'clone_and_refs', 'docker_args', 'container_networks', 'build_and_up']) {
    delete require.cache[require.resolve('./module_service/' + part + '.js')]
}

// Singleton modules share one coin/network-independent container name (see
// getDockerContainerImageNamePrefix). DB and EXPLORER have dedicated install
// branches that are already idempotent; HUB and SYNC fall through to the
// generic branch whose "already built?" check is keyed per coin/network, which
// can't see the one shared container, so installing across multiple networks
// would re-run `docker run` with a duplicate name and crash.
const SINGLETON_MODULES = [HUB_MODULE_NAME, SYNC_MODULE_NAME]

// True if a container with this exact name already exists (running or stopped).
// Mirrors getDatabaseContainerId's inspect-by-name probe.
async function containerExistsByName(name) {
    try {
        const { stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', name])
        return /^[a-f0-9]{64}$/.test(stdout.trim())
    } catch {
        return false
    }
}

async function installNodeModule(coin, network, remoteUpdate) {
    const { getLocalNodeVersion, checkRemoteNodeVersion } = versionService
    const { getRemoteModuleVersions, getLastStatus } = stateModule
    const { buildCryptoNode, getCryptoNode } = nodeService
    const containerVersion = getLastStatus()?.[coin ?? ""]?.[network ?? ""]?.[NODE_MODULE_NAME]?.["container_version"] ?? null
    if (containerVersion && !remoteUpdate) return false
    let localNodeVersion = null
    try {
        localNodeVersion = await getLocalNodeVersion(coin, network)
    } catch { /* not installed yet */ }
    if (localNodeVersion == null || remoteUpdate) {
        const remoteVersions = getRemoteModuleVersions()
        if (!(NODE_MODULE_NAME + SEP + coin in remoteVersions)) await checkRemoteNodeVersion(coin)
        const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
        await getCryptoNode(coin, network, remoteNodeVersion)
    }
    await buildCryptoNode(coin, network)
    await statusChanged()
    return true
}

async function installDatabaseModule(coin, network) {
    const { buildDatabaseModule } = databaseService
    await buildDatabaseModule(coin, network)
    await statusChanged()
    return true
}

async function installExplorer(branch, remoteUpdate) {
    // An explicit update bypasses the status-row early returns and replaces the container.
    const { installExplorerModule } = peers.explorerService
    await installExplorerModule(remoteUpdate, branch)
    await statusChanged()
    return true
}

async function singletonAlreadyInstalled(module, coin, network, remoteUpdate) {
    if (!SINGLETON_MODULES.includes(module) || remoteUpdate) return false
    return containerExistsByName(getDockerContainerImageName(module, coin, network))
}

// Refuse credential rotations while the working container is still intact.
// The post-build guards run after replacement and can no longer keep a sibling
// on its deployed password, so the module being replaced is the only exclusion.
async function assertCredentialCompatibility(module, coin, network, onlyExecution) {
    if ((module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) && !onlyExecution) {
        const { assertNoDbCredentialDrift } = dbCredentialDrift
        const driftCfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, coin, network)
        await assertNoDbCredentialDrift(coin, network, {
            decoder: driftCfg["DECODER_DB_PASS"],
            indexer: driftCfg["INDEXER_DB_PASS"]
        }, { excludeModules: [module] })
    }
    if (module === HUB_MODULE_NAME && !onlyExecution) {
        const { assertNoHubDbCredentialDrift } = dbCredentialDrift
        const hubCfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)
        await assertNoHubDbCredentialDrift(
            { user: hubCfg["HUB_DB_USER"], pass: hubCfg["HUB_DB_PASS"] },
            { excludeContainers: [getDockerContainerImageName(HUB_MODULE_NAME, "", "")] }
        )
    }
}

// A release manifest selects both the ref and verified commit. Outside a
// release install, the operator's branch remains the ref and carries no pin.
// Detached pinned checkouts compare commits so repeated installs do not clone.
async function checkoutModule(module, branch, remoteUpdate, localModuleVersion) {
    const { resolveComponentRef } = releaseManifestService
    const pin = resolveComponentRef(module, branch)
    if (remoteUpdate || localModuleVersion == null) {
        await cloneGit(module, true, false, pin.ref, pin.commit)
        return
    }
    if (!pin.ref || !moduleDirExists(module)) return
    const currentBranch = await getModuleBranch(module)
    const alreadyThere = pin.pinned
        ? (await getModuleCommit(module)) === pin.commit
        : currentBranch === pin.ref
    if (!alreadyThere) {
        logger.info(`Module '${module}' is on '${currentBranch}', switching to '${pin.ref}'...`)
        await cloneGit(module, true, false, pin.ref, pin.commit)
    }
}

// Freshness is sampled before the service starts. The tracker creates LevelDB
// immediately and decoder/indexer begin filling their blocks table, so checking
// after buildAndUp could hide a fresh store. Unknown inspection results remain
// non-fresh because the restore path can drop populated database state.
async function sampleBootstrapFreshness(module, coin, network, onlyExecution) {
    let utxoWasFresh = false
    let mariaWasFresh = false
    if (module === XChainService.XCHAIN_UTXO_TRACKER && !onlyExecution) {
        const { utxoTrackerVolumeFreshness, forceBootstrapRequested, FRESHNESS_EMPTY } = bootstrapService
        utxoWasFresh = (await utxoTrackerVolumeFreshness(coin, network)) === FRESHNESS_EMPTY || forceBootstrapRequested()
    }
    if ((module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) && !onlyExecution) {
        const { mariaDbModuleFreshness, forceBootstrapRequested, FRESHNESS_EMPTY } = bootstrapService
        mariaWasFresh = (await mariaDbModuleFreshness(coin, network, module)) === FRESHNESS_EMPTY || forceBootstrapRequested()
    }
    return { utxoWasFresh, mariaWasFresh }
}

// Database credentials are rotated after the replacement starts, while the hub
// grant is also established inside buildAndUp before its status push. Bootstrap
// restoration then runs only for the confirmed-fresh stores sampled above.
async function finishServiceInstall(context, freshness) {
    const { module, coin, network, overwriteContainerId, onlyExecution, dockerCmdArgs } = context
    const containerId = await buildAndUp(module, coin, network, overwriteContainerId, onlyExecution, dockerCmdArgs)
    if (module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) {
        await setDatabaseParameters()
    } else if (module === HUB_MODULE_NAME) {
        await setHubDatabaseParameters()
    }
    if (freshness.utxoWasFresh) {
        const { ensureBootstrapUtxoTracker } = bootstrapService
        await ensureBootstrapUtxoTracker(coin, network)
    }
    if (freshness.mariaWasFresh) {
        const { ensureBootstrapMariaDb } = bootstrapService
        await ensureBootstrapMariaDb(coin, network, module)
    }
    if (!onlyExecution) await statusChanged()
    return containerId
}

async function installServiceModule(context) {
    const { module, coin, network, remoteUpdate, onlyExecution, branch } = context
    if (await singletonAlreadyInstalled(module, coin, network, remoteUpdate)) return false
    const { getLastStatus } = stateModule
    const containerVersion = getLastStatus()?.[coin ?? ""]?.[network ?? ""]?.[module]?.["container_version"] ?? null
    if (containerVersion && !remoteUpdate) return false
    const { getLocalModuleVersion } = versionService
    let localModuleVersion = null
    try {
        localModuleVersion = await getLocalModuleVersion(module)
    } catch { /* not installed yet */ }
    await assertCredentialCompatibility(module, coin, network, onlyExecution)
    await checkoutModule(module, branch, remoteUpdate, localModuleVersion)
    const freshness = await sampleBootstrapFreshness(module, coin, network, onlyExecution)
    return finishServiceInstall(context, freshness)
}

async function installModule(module, coin, network, remoteUpdate = false, overwriteContainerId = null, onlyExecution = false, branch = null, dockerCmdArgs = null) {
    if (coin === "") coin = null
    if (network === "") network = null
    if (module === NODE_MODULE_NAME) return installNodeModule(coin, network, remoteUpdate)
    if (module === DB_MODULE_NAME) return installDatabaseModule(coin, network)
    if (module === EXPLORER_MODULE_NAME) return installExplorer(branch, remoteUpdate)
    return installServiceModule({ module, coin, network, remoteUpdate, overwriteContainerId, onlyExecution, branch, dockerCmdArgs })
}

async function uninstallModule(coin, network, module) {
    const { DB_MODULE_NAME } = config
    const modulesStatus = await getStatus(null, null, false)

    if (module === DB_MODULE_NAME) {
        throw "The database must be manually removed"
    }

    const moduleStatus = modulesStatus?.[(coin ?? "")]?.[(network ?? "")]?.[module]
    if (moduleStatus !== undefined) {
        logger.info("Uninstalling " + module + " (" + coin + "/" + network + ")")
        try {
            if (moduleStatus["status"]["State"]["Status"] !== "exited") {
                await stopModuleContainer(stopContainerByName, module, coin, network, moduleStatus["container_id"])
            }
            await removeContainer(moduleStatus["container_id"])
            await statusChanged()
            const removed = await db.deleteModuleContainer(module, coin, network)
            if (removed) {
                return removed
            } else {
                throw "There was a problem trying to remove a container from the database"
            }
        } catch (err) {
            // Preserve the original error instead of masking every failure in
            // this multi-step block (kill/remove/statusChanged/registry delete)
            // as a fixed "kill" message. Notably a successful `docker rm` with a
            // failed registry-row delete leaves the container gone but the
            // `modules` row stale, and the misleading message points diagnosis
            // at the wrong step.
            throw err
        }
    } else {
        // No live container found for this module (already removed, or never
        // built). A stale row can still linger in the `modules` tracking table
        // For example, the container may have been `docker rm`'d out of band, which silently
        // makes a later install/update misbehave. getStatus probes every tracked
        // container and drops the ones that are gone, so reaching here means the
        // container truly isn't present: clean up any orphaned row.
        const staleId = await db.getModuleContainer(module, coin, network)
        if (staleId) {
            await db.deleteModuleContainer(module, coin, network)
            await statusChanged()
            logger.info("Removed stale tracking row for " + module + " (" + coin + "/" + network + ")")
        }
        return true
    }
}

module.exports = {
    SERVICE_HEALTHCHECK,
    cloneGit,
    readCheckoutIdentityFromDisk,
    getModuleBranch,
    getModuleCommit,
    resolveBundledLibRef,
    buildAndUp,
    crossChainNetworksFor,
    buildHealthcheckArgs,
    buildModuleDockerArgs,
    resolveObservabilityEnv,
    OBSERVABILITY_ENV_KEYS,
    assertNoHostPortConflicts,
    installModule,
    uninstallModule
}
