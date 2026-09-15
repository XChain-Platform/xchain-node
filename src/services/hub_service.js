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
 * XChain Node - Hub Service
 * Install and configure the xchain-hub module
 ********************************************************************/

const {
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    EXTERNAL_DB, XChainService, DEFAULT_MODULE_BRANCH
} = require('../config')
const { db, getLastStatus, isStatusUpdated, isVerbose } = require('../state')
const { sleep, redactSecrets }                 = require('../utils/helpers')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork } = require('./config_service')
const { getStatus, getInstalledCoinsAndNetworks } = require('./status_service')
const { addContainerToNetwork }                = require('./docker_service')
const { cloneGit, buildAndUp }                 = require('./module_service')
const { addUserPasswordToDatabase, getExternalDbConfig } = require('./database_service')
// The explorer container's env is the durable record of the checkpoint self-sync
// opt-in; this reader already exists for the DB-credential drift guard and is
// tolerant of a missing container, which is exactly the posture wanted here.
const { readContainerEnv, assertNoHubDbCredentialDrift } = require('./db_credential_drift')
const HubConnector                             = require('./hub_connector.js')
const ExplorerConnector                        = require('./explorer_connector.js')
// Destructured where they are used, so each call reads the export at that moment.
const dockerService                            = require('./docker_service')
const releaseManifestService                   = require('./release_manifest_service')
const { getLogger } = require('../observability/logger');
const logger = getLogger();
const {
    buildHubModuleConfig, buildCheckpointConfig, isCheckpointSelfSyncEnabled
} = require('./hub_service/hub_module_config.js')
const {
    updateHubOrExplorer, configureUpdateHubOrExplorer
} = require('./hub_service/update_hub_or_explorer.js')
configureUpdateHubOrExplorer({
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, EXTERNAL_DB, XChainService,
    db, getLastStatus, isStatusUpdated, sleep, redactSecrets, getDefaultConfig,
    getStatus, getExternalDbConfig, readContainerEnv, HubConnector,
    ExplorerConnector, dockerService, buildHubModuleConfig, buildCheckpointConfig,
    isCheckpointSelfSyncEnabled, logger
})

// Attach one shared container to every installed coin/network, recording the
// ones that stay unreachable. addContainerToNetwork is idempotent (it no-ops
// when the container already holds the network), so the single retry only
// costs time on a real failure and absorbs the docker race that causes most
// of them; the failures it collects are what updateHub reports at the end
// instead of the discarded error that made a disconnected hub look installed.
async function attachSharedContainer(moduleLabel, containerId, installedCoinsAndNetworks, failures) {
    for (const nextCoin in installedCoinsAndNetworks) {
        for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
            try {
                await addContainerToNetwork(containerId, getDockerNetwork(nextCoin, nextNetwork))
            } catch (firstErr) {
                logger.info("There was an error trying to connect " + moduleLabel + " to the " +
                    nextCoin + "/" + nextNetwork + " network (" + redactSecrets(firstErr) + "). Trying again in 3 seconds...")
                await sleep(3000)
                try {
                    await addContainerToNetwork(containerId, getDockerNetwork(nextCoin, nextNetwork))
                } catch (retryErr) {
                    failures.push({
                        label: moduleLabel + " -> " + nextCoin + "/" + nextNetwork,
                        error: retryErr
                    })
                }
            }
        }
    }
}

// Does the hub answer right now? One request, no retries, no restart attempt.
//
// A container that is crash-looping is registered, has an id and reports a
// status, so every check that reads docker state calls it installed; only a
// request to its API tells the truth. Callers use this to decide whether the
// config push below is worth attempting at all, so it must stay cheap: the
// push itself already spends ten attempts three seconds apart on a hub that is
// down, which is the delay this is meant to avoid paying twice.
async function isHubAnswering() {
    const defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    const hubConnector  = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])
    return await hubConnector.ping()
}

// `skipConfigPush` attaches the shared containers to every coin network but
// leaves the hub's own config untouched. The attach is a docker operation and
// works against a container that is not serving; the push is an HTTP call that
// cannot. Set by a caller that already knows the hub is down and has decided
// the command may proceed anyway (see preCheck).
async function updateHub({ skipConfigPush = false } = {}) {
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const hubContainerId = await db.getModuleContainer(HUB_MODULE_NAME, "", "")
    const failures = []

    if (hubContainerId) {
        await attachSharedContainer("xchain-hub", hubContainerId, installedCoinsAndNetworks, failures)
        if (!skipConfigPush) await updateHubOrExplorer(HUB_MODULE_NAME)
    }

    // Connect xchain-sync container to all chain/network Docker networks (same pattern as hub)
    const syncContainerId = await db.getModuleContainer(SYNC_MODULE_NAME, "", "")
    if (syncContainerId) {
        await attachSharedContainer("xchain-sync", syncContainerId, installedCoinsAndNetworks, failures)
    }

    // Report unreachable networks instead of returning success: a topology
    // change that publishes module config while the shared container never
    // joined the new network leaves those endpoints dead until an unrelated
    // later mutation happens to retry the attach.
    if (failures.length > 0) {
        throw new Error(
            "Couldn't attach shared containers to " + failures.length + " network(s): " +
                failures.map((f) => f.label + " (" + redactSecrets(f.error) + ")").join('; '),
            { cause: failures[0].error }
        )
    }

    return true
}

async function useInstalledHub(hubConnector) {
    logger.info("Checking if xchain-hub module is installed")
    if (!isStatusUpdated()) return false

    const lastStatus = getLastStatus()
    const hubStatus = lastStatus?.[""]?.[""]?.[HUB_MODULE_NAME]
    if (hubStatus === undefined) return false

    if (hubStatus["status"]["State"]["Status"] === "exited") {
        logger.info("The hub module container status is 'exited'. Restarting it...")
        const { restartContainer } = dockerService
        const restarted = await restartContainer(hubStatus["container_id"])
        // An exited hub that will not restart cannot receive the config, so stop here.
        if (restarted !== true) {
            throw false
        }
        logger.info("Waiting for the xchain-hub to respond")
        let restartTries = 10
        while (restartTries > 0) {
            const ping = await hubConnector.ping()
            if (ping) break
            restartTries--
            await sleep(2000)
        }
    }
    return true
}

// `branch` is the ref the invoking command named, threaded down from preCheck,
// or null for every command that names none (which is most of them, and their
// behaviour is unchanged).
//
// The hub is the harder half of the ref-blind install pair: it is provisioned by
// preCheck, which runs BEFORE commander parses the action's arguments, so for its
// whole history it cloned whatever the default branch was regardless of the ref
// the operator asked for. Measured 2026-08-18: `install develop all bitcoin
// regtest` deployed the hub from master, and since the hub is the config oracle
// every other service then read its answers. A frozen-ref release e2e would have
// been a master hub grading a release stack.
async function installHubModule(branch = null) {
    const defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    if (isVerbose()) logger.info("Checking if xchain-hub module is running")
    const hubConnector = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])

    const pingHub = await hubConnector.ping()
    if (pingHub) return true

    if (await useInstalledHub(hubConnector)) return true

    logger.info("Downloading xchain-hub...")
    // Pinned like the generic path: a release install must stage the manifest's
    // hub, not the tip of whatever branch this checkout defaults to.
    //
    // This runs from preCheck, AHEAD of the action that publishes the install
    // target, so on a fresh box there is no active target to pin from and the
    // ref arrives raw. Resolving it here is what makes the two documented
    // operator forms work: `install xchain-hub` (no ref: the latest release,
    // pinned) and `install vX.Y.Z xchain-hub` on a train in which the hub did
    // not move (v0.15.1 pins hub v0.15.0, and the hub repo has no v0.15.1 tag,
    // so cloning the ref as a branch failed; measured in a sandbox 2026-09-08).
    // The target stays active through buildAndUp so the bundled libraries are
    // staged from the same manifest, and is cleared before returning; the
    // action's own withInstallTarget publishes its own afterwards.
    const {
        resolveComponentRef, getActiveTarget, isReleaseRef, resolveInstallTarget, setActiveTarget, clearActiveTarget
    } = releaseManifestService
    let ownsTarget = false
    if (!getActiveTarget() && (!branch || isReleaseRef(branch))) {
        const target = await resolveInstallTarget(branch, { defaultBranch: DEFAULT_MODULE_BRANCH })
        if (target.kind === 'release') {
            logger.info(`Staging the hub from release ${target.tag} (${target.resolvedFrom}); manifest-pinned.`)
            setActiveTarget(target)
            ownsTarget = true
        } else {
            branch = target.ref
        }
    }
    try {
        return await installHubFromResolvedRef(branch, defaultConfig, hubConnector)
    } finally {
        if (ownsTarget) clearActiveTarget()
    }
}

// The clone-build-wait half of installHubModule, split out so the target
// published above is cleared on every exit path.
async function installHubFromResolvedRef(branch, defaultConfig, hubConnector) {
    const { resolveComponentRef } = releaseManifestService
    const hubPin = resolveComponentRef(HUB_MODULE_NAME, branch)
    await cloneGit(HUB_MODULE_NAME, true, false, hubPin.ref, hubPin.commit)

    // Guard the install-time rotation too: it writes the same shared account, and it
    // runs BEFORE buildAndUp, so a sibling install's live hub is still serving on the
    // old password when the ALTER lands (uuid:a48aab2c). This install's own hub is
    // excluded because buildAndUp restarts it on the intended password moments later.
    await assertNoHubDbCredentialDrift(
        { user: defaultConfig["HUB_DB_USER"], pass: defaultConfig["HUB_DB_PASS"] },
        { excludeContainers: [getDockerContainerImageName(HUB_MODULE_NAME, "", "")] }
    )

    await addUserPasswordToDatabase(
        HUB_MODULE_NAME, "", "",
        defaultConfig["HUB_DB_NAME"], defaultConfig["HUB_DB_USER"], defaultConfig["HUB_DB_PASS"]
    )

    logger.info("Installing xchain-hub module...")
    await buildAndUp(HUB_MODULE_NAME, null, null)
    await getStatus(null, null, false)
    logger.info("Waiting for the xchain-hub to respond")

    let tries = 10
    while (tries > 0) {
        const ping = await hubConnector.ping()
        if (ping) {
            await updateHub()
            return true
        }
        tries--
        await sleep(2000)
    }

    throw "Couldn't install hub module"
}

module.exports = {
    updateHubOrExplorer,
    updateHub,
    isHubAnswering,
    installHubModule,
    // Exported for the unit suite: the self_sync/hub_url pairing is the whole
    // point of this block and must be pinned without booting a docker install.
    buildCheckpointConfig,
    // Same: the opt-in must survive a shell that never exported the env, and that
    // is pinned against a stubbed container-env read rather than a live docker.
    isCheckpointSelfSyncEnabled
}
