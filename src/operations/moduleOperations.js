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
const { NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, XChainService, SEP, dataDir, EXTERNAL_DB } = require('../config/constants')
const { db }                 = require('../state')
const { sleep }              = require('../utils/helpers')
const { getDockerContainerImageName, getUtxoTrackerVolumeName, filterCommandParameters, getDockerNetwork } = require('../services/ConfigService')
const { createDockerNetwork, killContainer, removeContainer, forceRemoveContainerByName, stopContainer, startContainer, restartContainer, execContainer, shellContainer, logContainer, startDockerMonitor, waitContainer, saveContainerLogs } = require('../services/DockerService')
const { buildDatabaseModule, resetDatabases, getDatabaseContainerId } = require('../services/DatabaseService')
const { getModuleBranch, installModule, uninstallModule } = require('../services/ModuleService')
const { assertHubNotBehind } = require('../services/SkewGuardService')
const { statusChanged } = require('../services/StatusService')

async function installModules(servicesList, branch = null) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            if (nextCoin && nextNetwork) {
                await createDockerNetwork(getDockerNetwork(nextCoin, nextNetwork))
                await buildDatabaseModule(nextCoin, nextNetwork)
            }
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                await installModule(nextModule, nextCoin, nextNetwork, false, null, false, branch)
            }
        }
    }
    return true
}

async function updateModules(servicesList, branch = null) {
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
                    await installModule(nextModule, nextCoin, nextNetwork, true, null)
                } else {
                    if (!moduleContainerId) continue
                    let moduleBranch = branch
                    if (!moduleBranch) {
                        try { moduleBranch = await getModuleBranch(nextModule) } catch { /* use default */ }
                    }
                    // remoteUpdate=true so installModule actually rebuilds the
                    // container. Without it, the `if (!containerNodeVersion ||
                    // remoteUpdate)` guard short-circuits for any already-installed
                    // service and `update` becomes a silent no-op.
                    //
                    // Version-skew guard : a hub-dependent service whose new
                    // source declares `xchainRequiresHub` in its package.json is
                    // REFUSED when the installed hub is behind that version, before
                    // anything is torn down. Throws out of updateModules so the
                    // update fails closed with nothing modified for this module.
                    await assertHubNotBehind(nextModule, moduleBranch)
                    // moduleBranch MUST be threaded through: installModule re-clones the
                    // module on the remoteUpdate path (cloneGit with this `branch`), so a
                    // null branch here re-clones the default branch and clobbers the branch
                    // the operator asked for (the cause of `update <svc> <chain> <net>
                    // <branch>` silently deploying master). installModule does the clone, so
                    // no separate cloneGit is needed here.
                    await installModule(nextModule, nextCoin, nextNetwork, true, moduleContainerId, false, moduleBranch)
                }
            }
        }
    }
    return true
}

async function uninstallModules(servicesList, includeShared = false) {
    const sharedModules = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (!includeShared && sharedModules.includes(nextModule)) continue
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!moduleContainerId) continue
                try {
                    await uninstallModule(nextCoin, nextNetwork, nextModule)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
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

async function runE2ETest(coin, network, testName = null, grep = null, script = null) {
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
    const containerId = await installModule(XChainService.XCHAIN_E2E_TEST, coin, network, true, null, true, null, dockerCmdArgs)

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

async function resetModules(service, coin, network, force = false) {
    const resetAll         = service === 'all'
    const resetNode        = resetAll || service === NODE_MODULE_NAME
    const resetUtxoTracker = resetAll || service === XChainService.XCHAIN_UTXO_TRACKER
    const resetDecoder     = resetAll || service === XChainService.XCHAIN_DECODER
    const resetIndexer     = resetAll || service === XChainService.XCHAIN_INDEXER

    // Relocated blocks/txindex host paths (XCHAIN_NODE_BLOCKS_DIR mode): these
    // live OUTSIDE the in-datadir path the node wipe clears, so they must be
    // wiped explicitly and named in the confirmation, else a reset restarts the
    // daemon over a stale blocks dir + stale txindex (uuid:90630038).
    // Env-first with config/node.local fallback : a reset from a
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
        if (resetIndexer)     targets.push('xchain-indexer database')
        const confirmed = await confirmDestructiveReset(coin, network, targets)
        if (!confirmed) {
            console.log('Aborted: reset was not confirmed. No data was touched.')
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
    for (const module of modulesToStop) {
        try {
            const containerId = await db.getModuleContainer(module, coin, network)
            // Latent today only because the catch below hides a null-arg
            // failure; guard explicitly so a future narrower catch stays
            // correct (uuid:fd7cc224 sibling site).
            if (!containerId) continue
            await stopContainer(containerId)
        } catch { /* not installed, skip */ }
    }

    // Fail fast BEFORE any destructive wipe: in docker (non-external) mode a
    // DB reset needs the MariaDB container, and resetDatabases would otherwise
    // `docker exec null` and abort mid-reset with node/utxo data already wiped
    // (the half-reset failure the EXTERNAL_DB branch already guards). Probe here
    // so nothing is touched when the container is gone (uuid:6f6584dc).
    const dbResetNeeded = resetDecoder || resetIndexer
    if (dbResetNeeded && !EXTERNAL_DB) {
        const dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) {
            console.log('Aborted: MariaDB container not found; install the database first. No data was touched.')
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
