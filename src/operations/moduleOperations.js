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
 * XChain Node - Module Operations
 * Bulk operations over lists of modules (install, start, stop, etc.)
 ********************************************************************/

const path      = require('path')
const fs        = require('fs')
const readline  = require('readline')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const { NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, XChainService, SEP, dataDir, EXTERNAL_DB, Coin, CoinTickerSymbol, Network, DEFAULT_MODULE_BRANCH } = require('../config/constants')
const { db }                 = require('../state')
const { sleep }              = require('../utils/helpers')
const { getDockerContainerImageName, getUtxoTrackerVolumeName, filterCommandParameters, getDockerNetwork } = require('../services/ConfigService')
const { createDockerNetwork, killContainer, removeContainer, forceRemoveContainerByName, stopContainer, startContainer, restartContainer, execContainer, shellContainer, logContainer, startDockerMonitor, waitContainer, saveContainerLogs } = require('../services/DockerService')
const { buildDatabaseModule, resetDatabases, clearHubPriceIngestWatermark, getDatabaseContainerId } = require('../services/DatabaseService')
const { getModuleBranch, installModule, uninstallModule } = require('../services/ModuleService')
const { assertHubNotBehind } = require('../services/SkewGuardService')
const { assertRequiredMigrationsApplied } = require('../services/MigrationPreconditionService')
const { statusChanged } = require('../services/StatusService')

// Resolve the operator's single ref slot into an install target and publish it
// for the duration of the run, so every module clone and every bundled-library
// staging inside it resolves against ONE decision (release-management spec
// section 11). Cleared in a finally, or a later branch install in the same
// process would inherit a stale pin.
async function withInstallTarget(ref, run) {
    const {
        resolveInstallTarget, setActiveTarget, clearActiveTarget
    } = require('../services/ReleaseManifestService')

    const target = await resolveInstallTarget(ref, { defaultBranch: DEFAULT_MODULE_BRANCH })

    if (target.kind === 'release') {
        console.log(`Installing XChain ${target.tag} (${target.resolvedFrom}); every component is manifest-pinned.`)
    } else {
        console.log(`Installing from branch '${target.ref}' (UNRELEASED: tracking install, no version pinning).`)
    }

    setActiveTarget(target)
    try {
        return await run(target)
    } finally {
        clearActiveTarget()
    }
}

/**
 * Install every requested module and REPORT what was actually built.
 *
 * installModule returns false for a module it decided not to touch (already
 * installed, or a singleton container that a previous coin/network pass in this
 * same run already created). That return used to be dropped on the floor, so
 * "built six containers" and "built nothing" printed the same and exited the
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
        return outcome
    })
}

async function updateModules(servicesList, ref = null) {
    const { isReleaseRef } = require('../services/ReleaseManifestService')

    // `update` with no ref keeps its established meaning: same branch per
    // module, newer commits. Only an explicitly named release ref switches this
    // run to pinned mode. (Install differs deliberately: a no-ref INSTALL has
    // no per-module branch to inherit, so it resolves the latest release.)
    if (!isReleaseRef(ref)) {
        return updateModulesOnBranch(servicesList, ref)
    }

    return withInstallTarget(ref, async () => updateModulesOnBranch(servicesList, null))
}

/**
 * Record ONE installModule call in an update outcome.
 *
 * installModule returns false when it declined to touch the module (its
 * early-return paths) and a container id / true when it built one. Counting
 * every call as "updated" regardless - which is what the loop used to do with
 * that return value - is how a run that rebuilt nothing still reported a
 * landed deploy and exited 0.
 */
function recordInstallOutcome(outcome, result, module, coin, network) {
    if (result === false) {
        console.warn(`update: ${module} (${coin} ${network}) was not rebuilt; nothing changed for it.`)
        outcome.skipped.push({ module, coin, network, reason: 'no-op' })
    } else {
        outcome.updated.push({ module, coin, network })
    }
}

/**
 * Runs the update over every requested module and REPORTS what it did.
 *
 * The report exists because the old `return true` made "updated three
 * containers" and "matched nothing at all" indistinguishable to the caller, so
 * a run that changed nothing still exited 0 and read as a landed deploy. The
 * caller (cli `update`) turns an empty `updated` list into a non-zero exit.
 *
 * @returns {Promise<{updated: Array, skipped: Array}>}
 */
async function updateModulesOnBranch(servicesList, branch = null) {
    const outcome = { updated: [], skipped: [] }
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (nextModule === NODE_MODULE_NAME) {
                    // Tear down the existing node container before rebuilding. The node
                    // branch of installModule calls buildCryptoNode, which `docker run
                    // --name`s the node but never removes a prior container of that name
                    // on `update` that collided and crashed (unhandled rejection).
                    // Remove by NAME so it also clears a leftover Created-state carcass
                    // the module registry no longer tracks; a no-op on a clean or
                    // already-missing node. (Done here rather than inside buildCryptoNode
                    // to keep that hot path, shared with fresh `install`, untouched;
                    // the node is briefly down during the image rebuild, which an update
                    // implies anyway.)
                    await forceRemoveContainerByName(getDockerContainerImageName(NODE_MODULE_NAME, nextCoin, nextNetwork))
                    // Recreate even when the container was missing from the registry:
                    // the old `if (!moduleContainerId) continue` made `update node` a
                    // silent no-op (exit 0, nothing created) once the node had crashed or
                    // been removed; only `install master node` could bring it back.
                    // installModule's remoteUpdate path rebuilds it from local source.
                    const built = await installModule(nextModule, nextCoin, nextNetwork, true, null)
                    recordInstallOutcome(outcome, built, nextModule, nextCoin, nextNetwork)
                } else {
                    if (!moduleContainerId) {
                        // Skipping is still right for `update all` on a partly
                        // installed stack, but skipping SILENTLY is what let a
                        // targeted `update <svc> <chain> <net>` print nothing,
                        // change nothing and exit 0. Say it, and record it so
                        // the caller can fail a run that updated nothing.
                        console.warn(`update: ${nextModule} (${nextCoin} ${nextNetwork}) has no registered container; nothing to update. Install it first.`)
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-installed' })
                        continue
                    }
                    let moduleBranch = branch
                    if (!moduleBranch) {
                        try { moduleBranch = await getModuleBranch(nextModule) } catch { /* use default */ }
                    }
                    // remoteUpdate=true so installModule actually rebuilds the
                    // container. Without it, the `if (!containerNodeVersion ||
                    // remoteUpdate)` guard short-circuits for any already-installed
                    // service and `update` becomes a silent no-op.
                    //
                    // Version-skew guard: a hub-dependent service whose new
                    // source declares `xchainRequiresHub` in its package.json is
                    // REFUSED when the installed hub is behind that version, before
                    // anything is torn down. Throws out of updateModules so the
                    // update fails closed with nothing modified for this module.
                    // Under a pinned update the guard must read the PINNED
                    // source's package.json, not the branch tip: it clones into
                    // a tmp tree to find `xchainRequiresHub`, and reading that
                    // from a different ref than the one about to be installed
                    // is how a skew guard blesses a version it never saw.
                    const { resolveComponentRef } = require('../services/ReleaseManifestService')
                    const pin = resolveComponentRef(nextModule, moduleBranch)
                    await assertHubNotBehind(nextModule, pin.ref)
                    // Migration-precondition guard: a service whose new source asserts a
                    // GATED (mode=manual) migration at startup is REFUSED when the database
                    // it will use has not applied that migration, before anything is torn
                    // down. Without it the only thing that discovers the requirement is the
                    // recreated container crash-looping - which is exactly how a routine
                    // indexer deploy took all three mainnet indexers down on 2026-08-09.
                    // Reads the same PINNED ref as the skew guard above, for the same
                    // reason: a precondition read from a different ref than the one being
                    // installed is a check that blessed a version it never saw.
                    await assertRequiredMigrationsApplied(nextModule, nextCoin, nextNetwork, pin.ref)
                    // moduleBranch MUST be threaded through: installModule re-clones the
                    // module on the remoteUpdate path (cloneGit with this `branch`), so a
                    // null branch here re-clones the default branch and clobbers the branch
                    // the operator asked for (the cause of `update <svc> <chain> <net>
                    // <branch>` silently deploying master). installModule does the clone, so
                    // no separate cloneGit is needed here.
                    const rebuilt = await installModule(nextModule, nextCoin, nextNetwork, true, moduleContainerId, false, moduleBranch)
                    recordInstallOutcome(outcome, rebuilt, nextModule, nextCoin, nextNetwork)
                }
            }
        }
    }
    return outcome
}

// Modules whose container is not created from the config map by buildAndUp: the
// crypto node goes through buildCryptoNode and the database container through
// buildDatabaseModule, so neither has config env for this verb to re-stamp.
const RECREATE_UNSUPPORTED_MODULES = [NODE_MODULE_NAME, DB_MODULE_NAME]

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
    const { buildAndUp } = require('../services/ModuleService')
    const { setDatabaseParameters } = require('../services/DatabaseService')

    const outcome = { recreated: [], skipped: [] }
    let touchedDbModule = false
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (RECREATE_UNSUPPORTED_MODULES.includes(nextModule)) {
                    // Still a continue: `recreate all` legitimately sweeps past the
                    // node and the database. What changed is that the skip is now
                    // recorded, so a run that recreated NOTHING can be reported as
                    // the failed request it is instead of exiting 0.
                    console.log("recreate does not apply to " + nextModule + "; use `update " + nextModule + "` instead")
                    outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-recreatable' })
                    continue
                }
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                await buildAndUp(nextModule, nextCoin, nextNetwork, moduleContainerId, false, null, { reuseImage: true })
                outcome.recreated.push({ module: nextModule, coin: nextCoin, network: nextNetwork })
                if (nextModule === XChainService.XCHAIN_DECODER || nextModule === XChainService.XCHAIN_INDEXER) {
                    touchedDbModule = true
                }
            }
        }
    }

    // Provision AFTER every container is back on the config values, so the drift guard
    // in setDatabaseParameters sees the state we just converged rather than the one
    // that made the recreate necessary.
    if (touchedDbModule) await setDatabaseParameters()
    await statusChanged()
    return outcome
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
 * bitcoin still installed, `uninstall all dogecoin mainnet --include-shared` used
 * to take the explorer down for bitcoin too. Now the shared pass runs after the
 * per-coin pass (so a genuine full teardown still reaches them, the remaining set
 * being empty by then) and skips with a reason naming what is still installed.
 *
 * @returns {Promise<{uninstalled: Array, skipped: Array}>} on full success
 * @throws {Error} listing every module that failed, after all were attempted
 */
async function uninstallModules(servicesList, includeShared = false) {
    const sharedModules = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]
    const outcome = { uninstalled: [], skipped: [] }
    const failures = []
    const deferredShared = []

    const uninstallOne = async (nextModule, nextCoin, nextNetwork) => {
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

    // Shared pass. `remaining` is read AFTER the per-coin pass above, so a full
    // teardown finds it empty and still removes them. A coin/network module is any
    // registry row carrying a coin; shared services are registered under ''/''.
    if (deferredShared.length > 0) {
        let remaining = []
        try {
            remaining = (await db.getAllModuleContainers(null, null)).filter(r => r.coin)
        } catch (err) {
            // The registry is the only thing that can answer "is anything still
            // being served". Unreadable, we refuse rather than guess: leaving a
            // shared service up costs an operator one more command, tearing it
            // down under a live coin costs every other coin its explorer/hub.
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

async function logModules(servicesList, follow = true) {
    const moduleContainerIds = []
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                moduleContainerIds.push({
                    name: getDockerContainerImageName(nextModule, nextCoin, nextNetwork),
                    id: containerId
                })
            }
        }
    }

    if (moduleContainerIds.length > 0) {
        if (follow) {
            // A single interleaved TTY stream only makes sense for one
            // container; warn instead of silently dropping the rest so the
            // operator knows N-1 services are omitted from `tail all`.
            if (moduleContainerIds.length > 1) {
                const omitted = moduleContainerIds.slice(1).map(c => c["name"]).join(", ")
                console.log("Following only " + moduleContainerIds[0]["name"] + "; omitted: " + omitted)
            }
            const moduleName = moduleContainerIds[0]["name"]
            console.log("")
            console.log("")
            console.log("####" + moduleName + " LOGS####")
            console.log("")
            await logContainer(moduleContainerIds[0]["id"], follow)
        } else {
            // Non-follow dumps can safely iterate every selected service in
            // sequence (no shared TTY to interleave).
            for (const container of moduleContainerIds) {
                console.log("")
                console.log("")
                console.log("####" + container["name"] + " LOGS####")
                console.log("")
                await logContainer(container["id"], follow)
            }
        }
    } else {
        console.log("No service was selected")
    }
    return true
}

async function monitorModules(servicesList, follow = true) {
    const moduleContainerIds = []
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                moduleContainerIds.push({
                    name: getDockerContainerImageName(nextModule, nextCoin, nextNetwork),
                    id: containerId
                })
            }
        }
    }
    await startDockerMonitor(moduleContainerIds, follow)
    return true
}

async function restartModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await restartContainer(containerId)
                    await statusChanged()
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function stopModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await stopContainer(containerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function startModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await startContainer(containerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function execModules(servicesList, command) {
    const commandArgs = command.split(/\s+/)
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    const execStdOut = await execContainer(containerId, commandArgs)
                    console.log(execStdOut)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function shellModule(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await shellContainer(containerId)
                    return true
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

// `ref` is the ref to clone the e2e-test suite at, normally the same one the
// stack under test was installed at. Null keeps the default-branch behaviour
// every caller had before the option existed.
async function runE2ETest(coin, network, testName = null, grep = null, script = null, ref = null) {
    let dockerCmdArgs = null
    if (script) {
        // Run an arbitrary e2e npm script (e.g. test:security, test:perf:budget) so CI
        // can drive the stack-dependent suites beyond the default action suite. Takes
        // precedence over testName; the e2e-test image carries these scripts.
        dockerCmdArgs = ['npm', 'run', script]
    } else if (testName) {
        dockerCmdArgs = ['npx', 'mocha', '--timeout', '0', '--exit',
            '--require', './test/initialCheck.test.js',
            `test/actions/${testName}.test.js`]
        if (grep) dockerCmdArgs.push('--grep', grep)
    }
    const containerId = await installModule(XChainService.XCHAIN_E2E_TEST, coin, network, true, null, true, ref, dockerCmdArgs)

    console.log("Running e2e tests, please wait...")
    const exitCode = await waitContainer(containerId)

    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logFile = path.join(dataDir, 'e2e-logs', `${coin}-${network}-${timestamp}.log`)

    await saveContainerLogs(containerId, logFile)
    await removeContainer(containerId)

    return { logFile, exitCode }
}

// Prompts the operator to type "yes" before a destructive reset proceeds.
// Reused instead of duplicated so every call site aborts the exact same way
// on a non-affirmative answer. Not called at all when the caller passes
// force=true (CI/scripted resets).
async function confirmDestructiveReset(coin, network, targets) {
    if (!process.stdin.isTTY) {
        throw new Error(
            'reset: refusing to run a destructive reset on a non-interactive terminal without --yes. ' +
            'Re-run with --yes to confirm.'
        )
    }
    console.warn(`\nWARNING: this will IRREVERSIBLY destroy ${coin} ${network} data.`)
    console.warn(`  Affected stores: ${targets.join(', ')}`)
    console.warn('  This forces a full resync afterward. There is no undo.\n')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise((resolve) => {
        rl.question('Type "yes" to confirm: ', resolve)
    })
    rl.close()
    return answer.trim().toLowerCase() === 'yes'
}

// True when a docker error means the container is already gone. Matched the
// same way DockerService.removeContainer matches it; execFile puts docker's
// stderr into the error message, and stopContainer can also reject a plain
// string, which is a real failure and must not be read as a miss here.
function isNoSuchContainerError(err) {
    if (!err || typeof err === 'string') return false
    return /no such container/i.test(String(err.message || err.stderr || ''))
}

// Put back the services an aborted reset already stopped, so the abort leaves
// the stack as it found it rather than half torn down. Returns the modules that
// could not be restarted, for the operator message.
async function restartStoppedModules(modules, coin, network) {
    const failed = []
    for (const module of modules) {
        try {
            const containerId = await db.getModuleContainer(module, coin, network)
            if (!containerId) continue
            await startContainer(containerId)
        } catch {
            failed.push(module)
        }
    }
    return failed
}

// The service names `reset` can act on. `reset` is the only destructive CLI path
// and the only one that bypasses resolveArgs/filterCommandParameters, so it must
// validate its own raw args: without this an unrecognised service (a typo, or a
// non-resettable module like xchain-encoder) leaves every reset flag false, so
// `targets` is empty, no branch fires, and resetModules returns true - the CLI
// exits 0 reporting success after resetting nothing. Fail loud instead,
// matching resolveArgs/rollback and the "fail fast BEFORE any destructive wipe"
// convention this file already follows.
const RESETTABLE_SERVICES = [
    'all',
    NODE_MODULE_NAME,
    XChainService.XCHAIN_UTXO_TRACKER,
    XChainService.XCHAIN_DECODER,
    XChainService.XCHAIN_INDEXER
]

async function resetModules(service, coin, network, force = false) {
    if (!RESETTABLE_SERVICES.includes(service)) {
        throw new Error("reset: unknown service '" + service + "'; expected one of "
            + RESETTABLE_SERVICES.join(', '))
    }
    if (!Object.values(Coin).includes(coin)) {
        throw new Error("reset: unknown coin '" + coin + "'; expected one of "
            + Object.values(Coin).join(', '))
    }
    if (!Object.values(Network).includes(network)) {
        throw new Error("reset: unknown network '" + network + "'; expected one of "
            + Object.values(Network).join(', '))
    }
    const resetAll         = service === 'all'
    const resetNode        = resetAll || service === NODE_MODULE_NAME
    const resetUtxoTracker = resetAll || service === XChainService.XCHAIN_UTXO_TRACKER
    const resetDecoder     = resetAll || service === XChainService.XCHAIN_DECODER
    const resetIndexer     = resetAll || service === XChainService.XCHAIN_INDEXER

    // Relocated blocks/txindex host paths (XCHAIN_NODE_BLOCKS_DIR mode): these
    // live OUTSIDE the in-datadir path the node wipe clears, so they must be
    // wiped explicitly and named in the confirmation, else a reset restarts the
    // daemon over a stale blocks dir + stale txindex (uuid:90630038).
    // Env-first with config/node.local fallback: a reset from a
    // profile-less shell must still see the relocated stores, or it restarts
    // the daemon over stale out-of-datadir chain data.
    const { resolveBlocksDir } = require('../services/NodeService')
    const blocksDir     = await resolveBlocksDir()
    const blocksHostPath  = blocksDir ? `${blocksDir}/${coin}/${network}` : null
    const txindexHostPath = blocksDir ? `${blocksDir}/${coin}/${network}-txindex` : null

    if (!force) {
        const targets = []
        if (resetNode) {
            targets.push('node datadir')
            if (blocksDir) {
                targets.push(`relocated blocks dir (${blocksHostPath})`)
                targets.push(`relocated txindex dir (${txindexHostPath})`)
            }
        }
        if (resetUtxoTracker) targets.push(`xchain-utxo-tracker Docker volume (${getUtxoTrackerVolumeName(coin, network)})`)
        if (resetDecoder)     targets.push('xchain-decoder database')
        if (resetIndexer) {
            targets.push('xchain-indexer database')
            // Named in the confirmation because it is a change to the HUB's state, not
            // this chain's: the operator should see that the reset reaches across.
            targets.push('hub price ingest fence row for this chain (price_ingest_watermarks)')
        }
        const confirmed = await confirmDestructiveReset(coin, network, targets)
        if (!confirmed) {
            console.log('Aborted: reset was not confirmed. No data was touched.')
            return false
        }
    }

    // Fail fast BEFORE any destructive wipe: in docker (non-external) mode a
    // DB reset needs the MariaDB container, and resetDatabases would otherwise
    // `docker exec null` and abort mid-reset with node/utxo data already wiped
    // (the half-reset failure the EXTERNAL_DB branch already guards). Probe here
    // so nothing is touched when the container is gone (uuid:6f6584dc). It sits
    // ahead of the stop loop, not after it: this abort returns before the restart
    // pass, so probing later left every already-stopped service DOWN while still
    // reporting that no data was touched (uuid:bb190060).
    const dbResetNeeded = resetDecoder || resetIndexer
    if (dbResetNeeded && !EXTERNAL_DB) {
        const dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) {
            console.log('Aborted: MariaDB container not found; install the database first. No data was touched.')
            return false
        }
    }

    const modulesToStop = []
    if (resetNode)        modulesToStop.push(NODE_MODULE_NAME)
    if (resetUtxoTracker) modulesToStop.push(XChainService.XCHAIN_UTXO_TRACKER)
    if (resetDecoder)     modulesToStop.push(XChainService.XCHAIN_DECODER)
    if (resetIndexer)     modulesToStop.push(XChainService.XCHAIN_INDEXER)
    if (resetAll)         modulesToStop.push(XChainService.XCHAIN_REGTEST_MINER)

    console.log(`Stopping ${coin} ${network} services...`)
    // Abort before any wipe when a target will not stop, and put back whatever
    // was already stopped. The bare catch this replaced swallowed EVERY
    // stopContainer rejection as "not installed", so a daemon that failed to
    // stop kept reading and writing the store while the wipes below deleted it
    // (uuid:9c88cfe6). Only a "no such container" miss is still a legitimate
    // skip; the registry miss is already handled by the null check.
    const stoppedModules = []
    for (const module of modulesToStop) {
        let containerId = null
        try {
            containerId = await db.getModuleContainer(module, coin, network)
        } catch { continue /* not installed, skip */ }
        // getModuleContainer returns null on a registry miss rather than
        // throwing, so only this explicit check can skip "not installed";
        // without it stopContainer(null) fails and now ABORTS the reset
        // (uuid:fd7cc224 sibling site).
        if (!containerId) continue
        try {
            await stopContainer(containerId)
            stoppedModules.push(module)
        } catch (err) {
            if (isNoSuchContainerError(err)) continue
            const restartFailures = await restartStoppedModules(stoppedModules, coin, network)
            const reason = (err && err.message) || String(err)
            console.log(`Aborted: ${module} failed to stop (${reason}). No data was touched.`)
            if (stoppedModules.length > 0) {
                console.log(`  Restarted ${stoppedModules.length - restartFailures.length} of `
                    + `${stoppedModules.length} already-stopped service(s).`)
            }
            if (restartFailures.length > 0) {
                console.log(`  STILL DOWN, start by hand: ${restartFailures.join(', ')}`)
            }
            return false
        }
    }

    if (resetNode) {
        const nodeDataPath = path.join(dataDir, NODE_MODULE_NAME, coin, network)
        if (fs.existsSync(nodeDataPath)) {
            console.log(`Clearing node data at ${nodeDataPath}...`)
            await execFileAsync('docker', ['run', '--rm', '-v', `${nodeDataPath}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
        }
        // Relocated blocks/txindex (XCHAIN_NODE_BLOCKS_DIR) live outside the
        // datadir, so wipe them here too or the daemon restarts over stale
        // chain data (uuid:90630038).
        for (const relocated of [blocksHostPath, txindexHostPath]) {
            if (relocated && fs.existsSync(relocated)) {
                console.log(`Clearing relocated node data at ${relocated}...`)
                await execFileAsync('docker', ['run', '--rm', '-v', `${relocated}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
            }
        }
    }

    if (resetUtxoTracker) {
        // Routed through the shared helper (uuid:7523dd94): the unprefixed name
        // used here previously wiped the DEFAULT_NODE_PREFIX stack's volume
        // under a non-default NODE_PREFIX, silently missing the intended target.
        const volumeName = getUtxoTrackerVolumeName(coin, network)
        try {
            console.log(`Clearing Docker volume ${volumeName}...`)
            await execFileAsync('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
        } catch { /* volume may not exist, skip */ }
    }

    const dbModulesToReset = [
        ...(resetDecoder ? [XChainService.XCHAIN_DECODER] : []),
        ...(resetIndexer ? [XChainService.XCHAIN_INDEXER] : []),
    ]
    if (dbModulesToReset.length > 0) {
        await resetDatabases(coin, network, dbModulesToReset)
    }

    // A wiped indexer DB restarts push_generations at 0, which the hub's price
    // ingest fence reads as a stale replay and DROPS, killing this chain's price
    // rail (and the native-fee / XCHAIN-USD path) with no error. Clear the fence
    // row here, while the indexer is still stopped, so the first push after the
    // restart below lands. Never fatal: the wipe already happened, so a failure
    // must not abort the restart pass and leave the stack down. It is reported
    // loudly instead, with the statement to run by hand.
    if (resetIndexer) {
        try {
            await clearHubPriceIngestWatermark(coin, network)
        } catch (err) {
            console.warn('WARNING: clearing the hub price ingest fence failed: ' + (err && err.message ? err.message : err))
            console.warn("  Run on the hub DB before the indexer catches up:")
            console.warn("    DELETE FROM price_ingest_watermarks WHERE source_chain = '"
                + (CoinTickerSymbol[coin] || coin) + "';")
        }
    }

    console.log(`Restarting ${coin} ${network} services...`)
    // Track restart failures instead of swallowing them: a silent skip here
    // left a wiped stack DOWN (node never restarted, every dependent service
    // crash-looped) while `reset` still reported success. "Not installed"
    // (registry miss) stays a legitimate skip; a failed docker start gets one
    // retry, then is reported loudly at the end.
    const startFailures = []
    for (const module of modulesToStop) {
        let containerId = null
        try {
            containerId = await db.getModuleContainer(module, coin, network)
        } catch { continue /* not installed, skip */ }
        // getModuleContainer never throws on a registry miss (MariaDbStore
        // returns null), so the catch above cannot catch "not installed" -
        // only this explicit null check can. Without it, startContainer(null)
        // fails on every branch and every `reset all` on mainnet/testnet
        // (where the regtest-only miner has no registry row) reports a false
        // failure after the reset actually succeeded (uuid:fd7cc224).
        if (!containerId) continue /* not installed, skip */
        try {
            await startContainer(containerId)
        } catch (firstErr) {
            console.warn(`Failed to start ${module} (${firstErr && firstErr.message}); retrying in 3s...`)
            await sleep(3000)
            try {
                await startContainer(containerId)
            } catch (retryErr) {
                startFailures.push({ module, error: (retryErr && retryErr.message) || String(retryErr) })
            }
        }
    }

    // Workaround for a known race: the decoder + indexer's initial pool
    // connections sometimes lose the connection mid-startup right after a
    // DROP DATABASE / CREATE DATABASE cycle (their inner retry-on-connect
    // helps but doesn't fully cover the case where Node throws before the
    // retry loop is reached). A simple "settle then bounce" of decoder +
    // indexer after the first start pass is empirically deterministic and
    // costs ~5s on the happy path.
    const bounceCandidates = [XChainService.XCHAIN_DECODER, XChainService.XCHAIN_INDEXER]
        .filter((m) => modulesToStop.includes(m))
    if (bounceCandidates.length > 0) {
        await sleep(5000)
        for (const module of bounceCandidates) {
            try {
                const containerId = await db.getModuleContainer(module, coin, network)
                // Latent today only because the catch below hides a null-arg
                // failure; guard explicitly so a future narrower catch stays
                // correct (uuid:fd7cc224 sibling site).
                if (!containerId) continue
                // restartContainer = docker stop + docker start; sufficient to
                // re-enter Node's bootstrap with the freshly-created DB ready.
                await restartContainer(containerId)
            } catch { /* not installed, skip */ }
        }
    }

    await statusChanged()

    if (startFailures.length > 0) {
        const detail = startFailures.map((f) => `${f.module}: ${f.error}`).join('; ')
        throw new Error(`reset completed but ${startFailures.length} service(s) failed to restart: ${detail}. Start them manually (docker start) or re-run reset.`)
    }
    return true
}

module.exports = {
    installModules,
    updateModules,
    recreateModules,
    uninstallModules,
    logModules,
    monitorModules,
    restartModules,
    stopModules,
    startModules,
    execModules,
    shellModule,
    runE2ETest,
    resetModules
}
