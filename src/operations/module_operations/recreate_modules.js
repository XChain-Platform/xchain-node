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
    const { setDatabaseParameters, setHubDatabaseParameters } = databaseService
    const outcome = { recreated: [], skipped: [] }, failures = []
    let touchedDbModule = false
    let touchedHubModule = false
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (RECREATE_UNSUPPORTED_MODULES.includes(nextModule)) {
                    // Still a continue: `recreate all` legitimately sweeps past the node and the database. What changed is that the skip is now recorded, so a run that recreated NOTHING can be reported as the failed request it is instead of exiting 0. The database has no `update` to redirect to either: that verb refuses it for the same reason (no container built from the config map, no in-place image upgrade). Say the real remedy.
                    const remedy = nextModule === DB_MODULE_NAME
                        ? "; the database container must be removed manually and reinstalled"
                        : "; use `update " + nextModule + "` instead"
                    console.log("recreate does not apply to " + nextModule + remedy)
                    outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-recreatable' })
                    continue
                }
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!moduleContainerId) {
                    // No registry row is TWO different states and this verb must not conflate them. Registry drift (row lost, container still up) has to keep recreating: dropping it was what made `update node` a silent no-op. An explicitly uninstalled venue must NOT: uninstall removes the container and the row but leaves the image tag, so buildAndUp's reuseImage check passes, `null` reads as "nothing to tear down", and the operator gets back a service they tore down, built from a stale image and re-stamped into the registry that status/precheck/autoheal trust. Discriminate on a POSITIVE docker answer only: 'unknown' is a daemon hiccup, not an absence.
                    const presence = await probeContainerPresenceByName(
                        getDockerContainerImageName(nextModule, nextCoin, nextNetwork))
                    if (presence === 'gone') {
                        console.warn(`recreate: ${nextModule} (${nextCoin} ${nextNetwork}) has no container; nothing to recreate. Install it first.`)
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-installed' })
                        continue
                    }
                }
                try {
                    await buildAndUp(nextModule, nextCoin, nextNetwork, moduleContainerId, false, null, { reuseImage: true })
                } catch (err) {
                    // Visiting the rest of the sweep after one venue fails follows uninstallModules: `recreate all` was already half-applied by the time it threw, and stopping there hid which venues had been touched behind one flat `recreate failed:`. The run still REJECTS below, naming every venue - a failure never becomes a skip.
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
    // Provision AFTER every container is back on the config values, so the drift guard in setDatabaseParameters sees the state we just converged rather than the one that made the recreate necessary.
    if (touchedDbModule) await setDatabaseParameters()
    // Same rule for the SHARED hub account, and it matters most on this verb: the recreated hub starts on the config store's HUB_DB_PASS, so without rotating the live 'xchain_hub'@'%' account to match, `recreate xchain-hub` hands the hub a password MariaDB never received and it crash-loops on ER_ACCESS_DENIED. The `update` path rotates here for the same reason (ModuleService installModule).
    if (touchedHubModule) await setHubDatabaseParameters()
    await statusChanged()
    if (failures.length) {
        // Rejecting AFTER provisioning is deliberate: the venues that did come back start on the config store's password and would crash-loop on ER_ACCESS_DENIED if the run bailed before rotating their accounts.
        throw new Error('recreate failed for ' + failures.length + ' module(s): '
            + failures.map(f => `${f.module} (${f.coin} ${f.network}): ${f.reason}`).join('; '))
    }
    return outcome
}

module.exports = { configure, recreateModules }
