/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/
'use strict'

let DB_MODULE_NAME, HUB_MODULE_NAME, NODE_MODULE_NAME, XChainService, databaseService, db, getDockerContainerImageName, moduleService, probeContainerPresenceByName, statusChanged
let RECREATE_UNSUPPORTED_MODULES

function configure(dependencies) {
    ({ DB_MODULE_NAME, HUB_MODULE_NAME, NODE_MODULE_NAME, XChainService, databaseService, db, getDockerContainerImageName, moduleService, probeContainerPresenceByName, statusChanged } = dependencies)
    RECREATE_UNSUPPORTED_MODULES = [NODE_MODULE_NAME, DB_MODULE_NAME]
}

// Modules whose container is not created from the config map by buildAndUp: the crypto node goes through buildCryptoNode and the database container through buildDatabaseModule, so neither has config env for this verb to re-stamp.
/**
 * Re-stamp a service's container from the CURRENT config without touching its image.
 *
 * A container freezes its env at `docker run`, so a config value it got wrong (a DB
 * password from another install's config store) cannot be corrected in place.
 * `update` corrects it only by also re-cloning from GitHub and rebuilding, which turns
 * a credential repair into an unreviewed version change on a live venue. This keeps the
 * image byte-identical and changes only what the config map now says.
 *
 * Reports what it recreated, for the same reason `update` does: an unsupported
 * module (node, database) was logged and skipped while the command still
 * exited 0, so `recreate node && echo ok` printed ok having recreated nothing.
 *
 * @param {Object} servicesList
 * @returns {Promise<{recreated: Array, skipped: Array}>}
 */
async function recreateModules(servicesList) {
    const { buildAndUp } = moduleService
    const outcome = { recreated: [], skipped: [] }, failures = []
    let touchedDbModule = false
    let touchedHubModule = false
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (RECREATE_UNSUPPORTED_MODULES.includes(nextModule)) {
                    // Record unsupported modules while allowing recreate all to continue.
                    const remedy = nextModule === DB_MODULE_NAME
                        ? "; the database container must be removed manually and reinstalled"
                        : "; use `update " + nextModule + "` instead"
                    console.log("recreate does not apply to " + nextModule + remedy)
                    outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-recreatable' })
                    continue
                }
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!moduleContainerId) {
                    // Distinguish registry drift from an explicitly uninstalled venue.
                    const presence = await probeContainerPresenceByName(
                        getDockerContainerImageName(nextModule, nextCoin, nextNetwork))
                    if (presence === 'gone') {
                        console.warn(`recreate: ${nextModule} (${nextCoin} ${nextNetwork}) has no container; nothing to recreate. Install it first.`)
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-installed' })
                        continue
                    }
                }
                try {
                    await buildAndUp(nextModule, nextCoin, nextNetwork, moduleContainerId, false, null,
                        { reuseImage: true, deferStatusPush: true })
                } catch (err) {
                    // Continue the sweep and report all failures together.
                    const why = (err && err.message) ? err.message : String(err)
                    console.error(`recreate: ${nextModule} (${nextCoin} ${nextNetwork}) FAILED: ${why}`)
                    failures.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: why })
                    continue
                }
                outcome.recreated.push({ module: nextModule, coin: nextCoin, network: nextNetwork })
                if (nextModule === XChainService.XCHAIN_DECODER || nextModule === XChainService.XCHAIN_INDEXER) {
                    touchedDbModule = true
                }
                if (nextModule === HUB_MODULE_NAME) {
                    touchedHubModule = true
                }
            }
        }
    }
    return finalizeRecreation(outcome, failures, touchedDbModule, touchedHubModule)
}

async function finalizeRecreation(outcome, failures, touchedDbModule, touchedHubModule) {
    const { setDatabaseParameters, setHubDatabaseParameters } = databaseService
    // Provision after every container returns to the current config values.
    if (touchedDbModule) await setDatabaseParameters()
    // Rotate the shared hub account only after its container returns.
    if (touchedHubModule) await setHubDatabaseParameters()
    await statusChanged()
    if (failures.length) {
        // Reject after provisioning the venues that did return.
        throw new Error('recreate failed for ' + failures.length + ' module(s): '
            + failures.map(f => `${f.module} (${f.coin} ${f.network}): ${f.reason}`).join('; '))
    }
    return outcome
}

module.exports = { configure, recreateModules }
