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
    EXTERNAL_DB, SERVICE_REGISTRY
} = require('../config/constants')

// Build the hub/explorer per-module config descriptor from the table-driven
// SERVICE_REGISTRY (constants.js) instead of a hand-maintained switch/case.
// Returns null for modules that contribute no hub config (hub/explorer/sync
// themselves, e2e-test) so the caller skips them, matching the old
// switch's default-no-op. The database descriptor is external-vs-dockerized
// and resolved from `ctx`; every other descriptor is a straight field map
// read from the coin/network default config.
function buildHubModuleConfig(nextModule, defaultConfigCoinNetwork, ctx) {
    const hubConfig = (SERVICE_REGISTRY[nextModule] || {}).hubConfig
    if (!hubConfig) return null

    if (hubConfig.type === 'database') {
        // External DB has no container; point the hub at the configured
        // external host so its module-config view reflects reality.
        return ctx.EXTERNAL_DB
            ? { host: ctx.externalDbCfg.host, port: ctx.externalDbCfg.port }
            : { host: 'mariadb', port: 3306 }
    }

    const config = {}
    for (const [outKey, envKey] of Object.entries(hubConfig.fields)) {
        config[outKey] = defaultConfigCoinNetwork[envKey]
    }
    return config
}
const { db, getLastStatus, isStatusUpdated, isVerbose } = require('../state')
const { sleep, redactSecrets }                 = require('../utils/helpers')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork } = require('./ConfigService')
const { statusChanged, getStatus, getInstalledCoinsAndNetworks } = require('./StatusService')
const { addContainerToNetwork }                = require('./DockerService')
const { cloneGit, buildAndUp }                 = require('./ModuleService')
const { addUserPasswordToDatabase, getExternalDbConfig } = require('./DatabaseService')
const HubConnector                             = require('../HubConnector.js')

async function updateHubOrExplorer(module) {
    if (![HUB_MODULE_NAME, EXPLORER_MODULE_NAME].includes(module)) {
        throw "Only the xchain-hub or the xchain-explorer could be updated"
    }

    const defaultConfig = await getDefaultConfig(module, null, null)
    let moduleConnector = null

    if (module === HUB_MODULE_NAME) {
        moduleConnector = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])
    } else {
        const ExplorerConnector = require('../ExplorerConnector.js')
        moduleConnector = new ExplorerConnector("127.0.0.1", defaultConfig["EXPLORER_PORT"])
    }

    await getStatus(null, null, false)

    if (!isStatusUpdated()) {
        throw "The status is not updated"
    }

    const lastStatus = getLastStatus()
    let jsonConfig = {}

    // Resolved once, outside the loops: in external-DB mode the module-config view
    // must report the host/port the pool actually opened against, which comes from
    // getExternalDbConfig() (env → saved credentials.json), not the load-time
    // EXTERNAL_DB_HOST/PORT constants. Those default to 127.0.0.1:3306, so a host
    // saved at the first-run prompt would be misreported to the hub (uuid:52c5b5f1).
    const externalDbCfg = EXTERNAL_DB ? await getExternalDbConfig() : null

    if (module === "xchain-explorer") {
        jsonConfig["configs"] = []
        jsonConfig = jsonConfig["configs"]
    }

    for (const nextCoin in lastStatus) {
        for (const nextNetwork in lastStatus[nextCoin]) {
            const defaultConfigCoinNetwork = await getDefaultConfig("", nextCoin, nextNetwork)
            let nextConfigObject = null

            if (module === "xchain-explorer") {
                nextConfigObject = { "coin": nextCoin, "network": nextNetwork }
                jsonConfig.push(nextConfigObject)
            }

            for (const nextModule in lastStatus[nextCoin][nextNetwork]) {
                const config = buildHubModuleConfig(nextModule, defaultConfigCoinNetwork, { EXTERNAL_DB, externalDbCfg })

                if (config != null) {
                    if (module === "xchain-explorer") {
                        nextConfigObject[nextModule] = config
                    } else {
                        if (!(nextCoin in jsonConfig)) jsonConfig[nextCoin] = {}
                        if (!(nextNetwork in jsonConfig[nextCoin])) jsonConfig[nextCoin][nextNetwork] = {}
                        jsonConfig[nextCoin][nextNetwork][nextModule] = config
                    }
                }
            }
        }
    }

    if (module === "xchain-explorer") {
        const explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")
        // getModuleContainer returns null on a registry miss rather than
        // throwing, so an uninstalled explorer previously fell through into
        // stringToDockerContainerFile(null, ...) and surfaced as the same
        // generic "problem trying to update a config" error as a real
        // failure, masking the actual cause (uuid:fd7cc224 sibling site).
        if (!explorerContainerId) {
            throw "xchain-explorer module is not installed; cannot update its config"
        }
        try {
            const { stringToDockerContainerFile } = require('./DockerService')
            await stringToDockerContainerFile(explorerContainerId, JSON.stringify(jsonConfig), "/XChainExplorer/src/config.json")
        } catch {
            throw "There was a problem trying to update a config in the " + module + " module"
        }
    } else {
        let hubUpdated = false
        let tries = 10
        // Keep the last failure. updateConfig is an HTTP call to the module's own
        // API, so when the container is crash-looping every attempt fails with a
        // connection error and this loop reports only "there was a problem" - which
        // hides the fact that the CONFIG is fine and the SERVICE never came up. That
        // misdirection cost real debugging time: the true cause was in the
        // container's own log, not here.
        let lastErr = null
        while (!hubUpdated) {
            try {
                hubUpdated = await moduleConnector.updateConfig(jsonConfig)
            } catch (err) { lastErr = err }

            tries--
            if (tries <= 0) {
                throw "There was a problem trying to update a config in the " + module + " module" +
                    (lastErr ? " (last error: " + redactSecrets(lastErr) + "; if this is a connection failure, check `docker logs` for the module - the service is not starting)" : "")
            }
            if (!hubUpdated) {
                console.log("There was a problem trying to update a config in the " + module + " module" +
                    (lastErr ? " (" + redactSecrets(lastErr) + ")" : "") + ". Trying again in 3 seconds...")
                await sleep(3000)
            }
        }
    }

    return true
}

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
                console.log("There was an error trying to connect " + moduleLabel + " to the " +
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

async function updateHub() {
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const hubContainerId = await db.getModuleContainer(HUB_MODULE_NAME, "", "")
    const failures = []

    if (hubContainerId) {
        await attachSharedContainer("xchain-hub", hubContainerId, installedCoinsAndNetworks, failures)
        await updateHubOrExplorer(HUB_MODULE_NAME)
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
    if (isVerbose()) console.log("Checking if xchain-hub module is running")
    const hubConnector = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])

    const pingHub = await hubConnector.ping()
    if (pingHub) return true

    console.log("Checking if xchain-hub module is installed")
    if (isStatusUpdated()) {
        const lastStatus = getLastStatus()
        const hubStatus = lastStatus?.[""]?.[""]?.[HUB_MODULE_NAME]

        if (hubStatus !== undefined) {
            if (hubStatus["status"]["State"]["Status"] === "exited") {
                console.log("The hub module container status is 'exited'. Restarting it...")
                const { restartContainer } = require('./DockerService')
                const restarted = await restartContainer(hubStatus["container_id"])
                if (restarted !== true) {
                    throw false
                }
                console.log("Waiting for the xchain-hub to respond")
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
    }

    console.log("Downloading xchain-hub...")
    // Pinned like the generic path: a release install must stage the manifest's
    // hub, not the tip of whatever branch this checkout defaults to.
    const { resolveComponentRef } = require('./ReleaseManifestService')
    const hubPin = resolveComponentRef(HUB_MODULE_NAME, branch)
    await cloneGit(HUB_MODULE_NAME, true, false, hubPin.ref, hubPin.commit)

    await addUserPasswordToDatabase(
        HUB_MODULE_NAME, "", "",
        defaultConfig["HUB_DB_NAME"], defaultConfig["HUB_DB_USER"], defaultConfig["HUB_DB_PASS"]
    )

    console.log("Installing xchain-hub module...")
    await buildAndUp(HUB_MODULE_NAME, null, null)
    await getStatus(null, null, false)
    console.log("Waiting for the xchain-hub to respond")

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
    installHubModule
}
