'use strict'

let DB_MODULE_NAME, EXPLORER_MODULE_NAME, HUB_MODULE_NAME, SYNC_MODULE_NAME, db, uninstallModule

function configure(dependencies) {
    ({ DB_MODULE_NAME, EXPLORER_MODULE_NAME, HUB_MODULE_NAME, SYNC_MODULE_NAME, db, uninstallModule } = dependencies)
}

/**
 * Uninstall every requested module, then FAIL if any of them failed.
 *
 * Visiting the rest of the list after one module fails is deliberate and stays:
 * an operator tearing down a stack wants the other containers gone. What was
 * wrong is that the per-module `catch` swallowed the error and the function
 * returned true regardless, so `uninstall all` reported a clean teardown while
 * leaving containers running - the exact "did nothing, said success" shape the
 * `update` no-op fix removed elsewhere.
 *
 * Shared services (database, hub, explorer, sync) are installed ONCE and serve
 * every coin/network on the box, so they are ordered LAST and only removed when
 * nothing is left to serve. `--include-shared` is a request, not an override: with
 * bitcoin still installed, `uninstall all dogecoin mainnet --include-shared` must
 * not take the explorer down for bitcoin too. The shared pass runs after the
 * per-coin pass (so a genuine full teardown still reaches them, the remaining set
 * being empty by then) and skips with a reason naming what is still installed.
 *
 * @returns {Promise<{uninstalled: Array, skipped: Array}>} on full success
 * @throws {Error} listing every module that failed, after all were attempted
 */
function createUninstallOne(outcome, failures) {
    return async (nextModule, nextCoin, nextNetwork) => {
        const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
        if (!moduleContainerId) {
            outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-installed' })
            return
        }
        try {
            await uninstallModule(nextCoin, nextNetwork, nextModule)
            outcome.uninstalled.push({ module: nextModule, coin: nextCoin, network: nextNetwork })
        } catch (err) {
            const why = (err && err.message) ? err.message : String(err)
            console.error(`uninstall: ${nextModule} (${nextCoin} ${nextNetwork}) FAILED: ${why}`)
            failures.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: why })
        }
    }
}

async function uninstallModules(servicesList, includeShared = false) {
    const sharedModules = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]
    const outcome = { uninstalled: [], skipped: [] }
    const failures = []
    const deferredShared = []
    const uninstallOne = createUninstallOne(outcome, failures)

    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (sharedModules.includes(nextModule)) {
                    if (!includeShared) {
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'shared' })
                    } else {
                        deferredShared.push({ module: nextModule, coin: nextCoin, network: nextNetwork })
                    }
                    continue
                }
                await uninstallOne(nextModule, nextCoin, nextNetwork)
            }
        }
    }

    // Shared pass. `remaining` is read AFTER the per-coin pass above, so a full teardown finds it empty and still removes them. A coin/network module is any registry row carrying a coin; shared services are registered under ''/''.
    if (deferredShared.length > 0) {
        let remaining = []
        try {
            remaining = (await db.getAllModuleContainers(null, null)).filter(r => r.coin)
        } catch (err) {
            // The registry is the only thing that can answer "is anything still being served". Unreadable, we refuse rather than guess: leaving a shared service up costs an operator one more command, tearing it down under a live coin costs every other coin its explorer/hub.
            const why = (err && err.message) ? err.message : String(err)
            for (const s of deferredShared)
                outcome.skipped.push({ ...s, reason: `shared, module registry unreadable (${why})` })
            deferredShared.length = 0
        }
        const stillServed = [...new Set(remaining.map(r => `${r.coin} ${r.network}`))].sort()
        for (const s of deferredShared) {
            if (stillServed.length > 0) {
                const reason = `shared, still serving ${stillServed.join(', ')}`
                console.warn(`uninstall: keeping ${s.module}; it is ${reason}.`)
                outcome.skipped.push({ ...s, reason })
                continue
            }
            await uninstallOne(s.module, s.coin, s.network)
        }
    }

    if (failures.length > 0) {
        const detail = failures.map(f => `${f.module} (${f.coin} ${f.network}): ${f.reason}`).join('; ')
        const err = new Error(`uninstall failed for ${failures.length} module${failures.length === 1 ? '' : 's'}: ${detail}`)
        err.failures = failures
        err.uninstalled = outcome.uninstalled
        throw err
    }
    return outcome
}

module.exports = { configure, uninstallModules }
