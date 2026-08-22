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
 * XChain Node - Explorer Service
 * Install and configure the xchain-explorer module
 ********************************************************************/

const {
    EXPLORER_MODULE_NAME
} = require('../config/constants')
const { db, getLastStatus, isStatusUpdated } = require('../state')
const { sleep, redactSecrets }               = require('../utils/helpers')
const { getDefaultConfig, getDockerNetwork } = require('./ConfigService')
const { statusChanged, getStatus, getInstalledCoinsAndNetworks } = require('./StatusService')
const { addContainerToNetwork, killContainer, removeContainer } = require('./DockerService')
const { cloneGit, buildAndUp }               = require('./ModuleService')
const ExplorerConnector                      = require('../ExplorerConnector.js')

async function updateExplorer() {
    const lastStatus = getLastStatus()
    const explorerStatus = lastStatus?.[""]?.[""]?.[EXPLORER_MODULE_NAME]

    if (explorerStatus === undefined) return true
    if (explorerStatus["status"]["State"]["Status"] === "exited") return true

    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")

    // Record the networks the explorer stays off instead of discarding the
    // error: a topology change that reported success while the container never
    // joined the new network left those explorer endpoints dead until an
    // unrelated later mutation happened to retry. addContainerToNetwork is
    // idempotent (DockerService no-ops when the container already holds the
    // network), so the single retry only costs time on a real failure and
    // absorbs the docker race that causes most of them. Same treatment as
    // HubService.attachSharedContainer, kept local so the two services keep
    // their independent dependency graphs.
    const failures = []

    if (explorerContainerId) {
        for (const nextCoin in installedCoinsAndNetworks) {
            for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
                const network = getDockerNetwork(nextCoin, nextNetwork)
                try {
                    await addContainerToNetwork(explorerContainerId, network)
                } catch (firstErr) {
                    console.log("There was an error trying to connect the xchain-explorer to the " +
                        nextCoin + "/" + nextNetwork + " network (" + redactSecrets(firstErr) + "). Trying again in 3 seconds...")
                    await sleep(3000)
                    try {
                        await addContainerToNetwork(explorerContainerId, network)
                    } catch (retryErr) {
                        failures.push({
                            label: "xchain-explorer -> " + nextCoin + "/" + nextNetwork,
                            error: retryErr
                        })
                    }
                }
            }
        }
    }

    if (failures.length > 0) {
        throw new Error(
            "Couldn't attach the xchain-explorer to " + failures.length + " network(s): " +
                failures.map((f) => f.label + " (" + redactSecrets(f.error) + ")").join('; '),
            { cause: failures[0].error }
        )
    }

    return true
}

// `branch` is the ref the invoking command named (`install <ref> ...`), or null
// for the commands that name none. It exists because this function is one of the
// two install paths that did not take one, and a clone with no ref takes the
// module's DEFAULT branch: measured 2026-08-18, `install develop all bitcoin
// regtest` built the explorer from master while every generic-path module built
// from develop, and the bundled xchain-vm then INHERITED master from it. That is
// not only a mixed stack, it is the failure mode the release ceremony's frozen-ref
// e2e gate exists to rule out, since `install release/vX.Y.Z` would have tested
// master's explorer and reported on the release.
//
// Resolved through resolveComponentRef for the same reason the generic path is: a
// pinned release install must pin everything it stages, or it is not a pinned
// install, and the explorer was staged unpinned.
async function installExplorerModule(force = false, branch = null) {
    const defaultConfig = await getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
    console.log("Checking if xchain-explorer module is running")
    const explorerConnector = new ExplorerConnector(defaultConfig["EXPLORER_HOST"], defaultConfig["EXPLORER_PORT"])

    if (!force) {
        const pingExplorer = await explorerConnector.ping()
        if (pingExplorer) return true

        console.log("Checking if xchain-explorer module is installed")
        if (isStatusUpdated()) {
            const lastStatus = getLastStatus()
            const explorerStatus = lastStatus?.[""]?.[""]?.[EXPLORER_MODULE_NAME]
            if (explorerStatus !== undefined) return true
        }
    } else {
        // Force-rebuild: tear down any existing explorer container + DB row so
        // the fresh clone + buildAndUp below doesn't collide with stale state.
        const existingContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")
        if (existingContainerId) {
            console.log("Force rebuild: removing existing xchain-explorer container")
            try { await killContainer(existingContainerId) }   catch { /* may already be exited */ }
            try { await removeContainer(existingContainerId) } catch { /* may already be gone */ }
            try { await db.removeModuleContainer(EXPLORER_MODULE_NAME, "", "") } catch { /* row may already be gone */ }
        }
    }

    console.log("Downloading xchain-explorer...")
    const { resolveComponentRef } = require('./ReleaseManifestService')
    const explorerPin = resolveComponentRef(EXPLORER_MODULE_NAME, branch)
    await cloneGit(EXPLORER_MODULE_NAME, true, false, explorerPin.ref, explorerPin.commit)
    console.log("Installing xchain-explorer module...")
    await buildAndUp(EXPLORER_MODULE_NAME, null, null)
    await getStatus(null, null, false)
    console.log("Waiting for the xchain-explorer to respond")

    // A healthy explorer is one holding at least one DB pool, and its pools come
    // from the COIN stacks. So on a host with no coin installed yet there is no
    // reply that can satisfy a health check, and demanding one made the first
    // install of a stack unsatisfiable by construction: `install <ref> all` puts
    // the explorer in the shared ("",  "") bucket, which runs BEFORE any coin
    // exists, so the explorer answered 503 degraded for ten seconds and the whole
    // install failed. Measured on a clean hosted runner 2026-08-18; it never
    // surfaced on a dev box or a CI venue because both already carry coin DBs
    // from an earlier install.
    //
    // So the bar is "answering" when there is no coin to serve, and stays the
    // full health check the moment there is one: with a coin installed, an
    // explorer holding no pools is a real fault and must still fail the install.
    const coinsPresent = Object.keys(await getInstalledCoinsAndNetworks()).length > 0

    let tries = 10
    while (tries > 0) {
        const { answering, healthy } = await explorerConnector.probe()
        if (healthy || (answering && !coinsPresent)) {
            try {
                await updateExplorer()
            } catch {
                tries--
                await sleep(1000)
                continue
            }
            if (!healthy) {
                console.log("xchain-explorer is up with no coin data to serve yet;" +
                    " it starts serving as each coin stack is installed.")
            }
            return true
        } else {
            await sleep(1000)
        }
        tries--
    }

    throw "Couldn't install the explorer module"
}

// Block until the explorer is actually serving, or the budget runs out.
//
// The explorer learns its coins by POLLING the hub (UPDATE_CONFIG_INTERVAL,
// one minute by default), so an explorer that booted before the coin stacks
// existed keeps answering 503 for up to a poll after they arrive. That gap is
// invisible and it is long: measured on a clean host, the coin stack finished
// at 14:55:47 and a suite that started at 14:57:04 still got a degraded
// explorer, because the tick that would have fixed it had not landed.
//
// An install that returns while a service it just installed serves nothing is
// reporting the wrong thing, and everything downstream inherits the race. This
// converges it instead of leaving each caller to discover it.
//
// Returns true when healthy, false when the budget expired: a slow explorer is
// not a reason to fail an install that otherwise succeeded, and the caller says
// so out loud rather than pretending the stack is ready.
// It waits only on an explorer that is TALKING. A degraded reply is a service
// mid-convergence and worth the budget; silence is a host with no explorer to
// converge (a coin-only install, a stack that never installed one), and grinding
// the full budget against it would add minutes to every such run for nothing.
// Whether the explorer came up at all is installExplorerModule's question, asked
// and answered before this is ever reached.
async function waitForExplorerReady(timeoutMs = 150000, silenceGraceMs = 6000) {
    const defaultConfig = await getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
    const explorerConnector = new ExplorerConnector(defaultConfig["EXPLORER_HOST"], defaultConfig["EXPLORER_PORT"])

    const started = Date.now()
    const deadline = started + timeoutMs
    let announced = false
    let everAnswered = false

    while (Date.now() < deadline) {
        const { answering, healthy } = await explorerConnector.probe()
        if (healthy) return true
        if (answering) everAnswered = true
        if (!everAnswered && Date.now() - started >= silenceGraceMs) return true

        if (answering && !announced) {
            console.log("Waiting for the xchain-explorer to pick up the installed coins" +
                " (it polls the hub for config, so this takes up to a poll interval)...")
            announced = true
        }
        await sleep(2000)
    }
    return false
}

module.exports = {
    updateExplorer,
    installExplorerModule,
    waitForExplorerReady
}
