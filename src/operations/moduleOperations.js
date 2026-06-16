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
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const { NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, XChainService, SEP, dataDir } = require('../config/constants')
const { db }                 = require('../state')
const { getDockerContainerImageName, filterCommandParameters, getDockerNetwork } = require('../services/ConfigService')
const { createDockerNetwork, killContainer, removeContainer, forceRemoveContainerByName, stopContainer, startContainer, restartContainer, execContainer, shellContainer, logContainer, startDockerMonitor, waitContainer, saveContainerLogs } = require('../services/DockerService')
const { buildDatabaseModule, resetDatabases } = require('../services/DatabaseService')
const { getModuleBranch, installModule, uninstallModule } = require('../services/ModuleService')
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
                    // — on `update` that collided and crashed (unhandled rejection).
                    // Remove by NAME so it also clears a leftover Created-state carcass
                    // the module registry no longer tracks; a no-op on a clean or
                    // already-missing node. (Done here rather than inside buildCryptoNode
                    // to keep that hot path — shared with fresh `install` — untouched;
                    // the node is briefly down during the image rebuild, which an update
                    // implies anyway.)
                    await forceRemoveContainerByName(getDockerContainerImageName(NODE_MODULE_NAME, nextCoin, nextNetwork))
                    // Recreate even when the container was missing from the registry:
                    // the old `if (!moduleContainerId) continue` made `update node` a
                    // silent no-op (exit 0, nothing created) once the node had crashed or
                    // been removed — only `install master node` could bring it back.
                    // installModule's remoteUpdate path rebuilds it from local source.
                    await installModule(nextModule, nextCoin, nextNetwork, true, null)
                } else {
                    if (!moduleContainerId) continue
                    let moduleBranch = branch
                    if (!moduleBranch) {
                        try { moduleBranch = await getModuleBranch(nextModule) } catch { /* use default */ }
                    }
                    // remoteUpdate=true so installModule actually rebuilds the
                    // container — without it, the `if (!containerNodeVersion ||
                    // remoteUpdate)` guard short-circuits for any already-installed
                    // service and `update` becomes a silent no-op.
                    //
                    // moduleBranch MUST be threaded through: installModule re-clones the
                    // module on the remoteUpdate path (cloneGit with this `branch`), so a
                    // null branch here re-clones the default branch and clobbers the branch
                    // the operator asked for — the cause of `update <svc> <chain> <net>
                    // <branch>` silently deploying master. (installModule does the clone, so
                    // no separate cloneGit is needed here.)
                    await installModule(nextModule, nextCoin, nextNetwork, true, moduleContainerId, false, moduleBranch)
                }
            }
        }
    }
    return true
}

async function uninstallModules(servicesList, includeShared = false) {
    const sharedModules = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME]
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
        const moduleName = moduleContainerIds[0]["name"]
        console.log("")
        console.log("")
        console.log("####" + moduleName + " LOGS####")
        console.log("")
        await logContainer(moduleContainerIds[0]["id"], follow)
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

async function resetModules(service, coin, network) {
    const resetAll         = service === 'all'
    const resetNode        = resetAll || service === NODE_MODULE_NAME
    const resetUtxoTracker = resetAll || service === XChainService.XCHAIN_UTXO_TRACKER
    const resetDecoder     = resetAll || service === XChainService.XCHAIN_DECODER
    const resetIndexer     = resetAll || service === XChainService.XCHAIN_INDEXER

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
            await stopContainer(containerId)
        } catch { /* not installed, skip */ }
    }

    if (resetNode) {
        const nodeDataPath = path.join(dataDir, NODE_MODULE_NAME, coin, network)
        if (fs.existsSync(nodeDataPath)) {
            console.log(`Clearing node data at ${nodeDataPath}...`)
            await execFileAsync('docker', ['run', '--rm', '-v', `${nodeDataPath}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
        }
    }

    if (resetUtxoTracker) {
        const volumeName = `${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${coin}-${network}-data`
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
        try {
            await startContainer(containerId)
        } catch (firstErr) {
            console.warn(`Failed to start ${module} (${firstErr && firstErr.message}); retrying in 3s...`)
            await new Promise((r) => setTimeout(r, 3000))
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
        await new Promise((r) => setTimeout(r, 5000))
        for (const module of bounceCandidates) {
            try {
                const containerId = await db.getModuleContainer(module, coin, network)
                // restartContainer = docker stop + docker start; sufficient to
                // re-enter Node's bootstrap with the freshly-created DB ready.
                await restartContainer(containerId)
            } catch { /* not installed, skip */ }
        }
    }

    await statusChanged()

    if (startFailures.length > 0) {
        const detail = startFailures.map((f) => `${f.module}: ${f.error}`).join('; ')
        throw new Error(`reset completed but ${startFailures.length} service(s) failed to restart — ${detail}. Start them manually (docker start) or re-run reset.`)
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
