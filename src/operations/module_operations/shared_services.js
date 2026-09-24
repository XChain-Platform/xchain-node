'use strict'

let bootstrapService, buildDatabaseModule, config, createDockerNetwork, explorerService, getDockerNetwork, hubService, installModule, withInstallTarget

function configure(dependencies) {
    ({ bootstrapService, buildDatabaseModule, config, createDockerNetwork, explorerService, getDockerNetwork, hubService, installModule, withInstallTarget } = dependencies)
}

/**
 * Install every requested module and REPORT what was actually built.
 *
 * installModule returns false for a module it decided not to touch (already
 * installed, or a singleton container that a previous coin/network pass in this
 * same run already created). Dropping that return on the floor makes
 * "built six containers" and "built nothing" print the same and exit the
 * same. Unlike `update`, a no-op install is NOT a failure - the desired state
 * already holds, and `install` is run idempotently by scripts and harnesses -
 * so the report is printed rather than turned into a non-zero exit.
 *
 * @returns {Promise<{installed: Array, skipped: Array}>}
 */
async function installModules(servicesList, ref = null) {
    return withInstallTarget(ref, async (target) => {
        // A release install passes no branch: resolveComponentRef inside
        // installModule supplies the pinned ref per component. A branch install
        // passes the branch, exactly as before.
        const branch = target.kind === 'release' ? null : target.ref
        const outcome = { installed: [], skipped: [] }
        // Per-run, so a second install in the same process reports its own
        // restores rather than replaying the first one's.
        bootstrapService.resetBootstrapOutcomes()

        try {
            for (const nextCoin in servicesList) {
                for (const nextNetwork in servicesList[nextCoin]) {
                    if (nextCoin && nextNetwork) {
                        await createDockerNetwork(getDockerNetwork(nextCoin, nextNetwork))
                        await buildDatabaseModule(nextCoin, nextNetwork)
                    }
                    for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                        const result = await installModule(nextModule, nextCoin, nextNetwork, false, null, false, branch)
                        if (result === false) {
                            outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'already-installed' })
                        } else {
                            outcome.installed.push({ module: nextModule, coin: nextCoin, network: nextNetwork })
                        }
                    }
                }
            }

            if (outcome.skipped.length > 0) {
                console.log('install: nothing to do for ' + outcome.skipped
                    .map(s => `${s.module} (${s.coin} ${s.network})`).join(', ')
                    + ' - already installed. Use `update` to rebuild.')
            }
        } finally {
            // In a finally because a run that throws is the one whose summary
            // matters most: it leaves some services restored and some facing
            // hours of resync, and the error alone does not say which.
            bootstrapService.reportBootstrapOutcomes()
        }

        // The explorer is installed in the shared bucket, which runs BEFORE the
        // coin stacks, and it learns its coins by polling the hub. So a run that
        // installed a coin leaves it serving 503 for up to a poll interval after
        // this loop ends. Returning there hands every caller a stack that reports
        // installed and answers nothing; the first one to be bitten was the e2e
        // gate, whose suite starts the moment install returns.
        return outcome
    })
}

// Make the coins this run installed usable before the command returns.
//
// updateHub and updateExplorer push coin config to the hub and JOIN the hub and
// explorer containers to each coin's docker network. They run in preCheck, which
// fires BEFORE the action, so an install that creates brand-new coin stacks ends
// without either shared service having heard about them: the explorer sits on no
// network from which the hub is reachable, never populates a DB pool, and answers
// 503 until some later command's preCheck happens to fix it. Measured on a clean
// host, it stayed degraded through a full 150-second readiness wait.
//
// This is a COMMAND-level step, not part of the install primitive: it reconciles
// against live docker, and installModules is also driven directly by suites whose
// container registry is fixture data that such a reconcile would purge.
//
// Returns whether the stack is usable. The modules are installed either way, but
// reporting success for a stack whose explorer serves 503 makes every later
// failure land on the caller's first read instead of here.
async function syncSharedServicesAfterInstall(outcome) {
    if (!outcome || !outcome.installed.some(i => i.coin && i.network)) return true

    const { updateHub } = hubService
    const { updateExplorer, waitForExplorerReady } = explorerService

    try { await updateHub() }      catch (err) { console.warn('install: could not push config to the hub: ' + err) }
    try { await updateExplorer() } catch (err) { console.warn('install: could not attach the explorer to the new coin networks: ' + err) }

    if (await waitForExplorerReady()) return true

    console.warn('install: the xchain-explorer is still not serving coin data.' +
        ' The stack is installed; the explorer either cannot reach the hub or the hub' +
        ' has no config for these coins yet. Check it before running anything that reads it.')

    // Escape hatch for the install-then-fix flows: the modules ARE installed, so a
    // caller that intends to repair the explorer by hand can still treat this as success.
    if (allowDegradedExplorer()) {
        console.warn('install: continuing anyway (XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER is set).')
        return true
    }
    return false
}

// Opt-out for callers that knowingly accept a stack whose explorer serves no coins.
function allowDegradedExplorer() {
    return ['1', 'true', 'yes'].includes(String(config.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER).toLowerCase())
}

module.exports = { configure, installModules, syncSharedServicesAfterInstall }
