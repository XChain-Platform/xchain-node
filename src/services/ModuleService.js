/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Module Service
 * Clone, build, install and uninstall XChain modules
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const fs        = require('fs')

const path = require('path')
const {
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    XChainService, SEP, modulesUrls, LIBRARY_BUNDLES
} = require('../config/constants')
const { db }                = require('../state')
const {
    getModuleDir, getModuleTmpDir, moduleDirExists, checkIfModuleExists,
    removeModuleDir, removeModuleTmpDir, createModuleTmpDir,
    getDockerContainerImageName, getDockerNetwork, getDefaultConfig, validatePort
} = require('./ConfigService')
const { statusChanged, getStatus } = require('./StatusService')
const { killContainer, removeContainer } = require('./DockerService')
const { setDatabaseParameters }  = require('./DatabaseService')

async function cloneGit(module, rewrite = false, useTmp = false, branch = null) {
    return new Promise((resolve, reject) => {
        if (useTmp) {
            removeModuleTmpDir(module)
            createModuleTmpDir(module)
        } else {
            if (moduleDirExists(module)) {
                if (rewrite) {
                    removeModuleDir(module)
                } else {
                    reject("Module directory already exists")
                    return
                }
            }
        }

        if (!(module in modulesUrls)) {
            reject("module doesn't have an url")
            return
        }

        if (branch && !/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
            reject("Invalid branch name: " + branch + " — branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes")
            return
        }

        const gitUrl = modulesUrls[module]
        const destination = useTmp ? getModuleTmpDir(module) : getModuleDir(module)
        const cloneArgs = ['clone']
        if (branch) cloneArgs.push('-b', branch)
        // Local-path sources (no ':' i.e. not a URL/SCP-style remote) on the
        // Parallels share can't hardlink between the two trees, so force
        // a copy instead of git's default object-linking.
        if (gitUrl && gitUrl.startsWith('/')) cloneArgs.push('--no-hardlinks')
        cloneArgs.push(gitUrl, destination)

        execFile('git', cloneArgs, (error, stdout, stderr) => {
            if (error) {
                if (branch && stderr && stderr.toLowerCase().includes('not found')) {
                    console.warn(`WARNING: Branch '${branch}' not found for module '${module}'. Falling back to default branch (master).`)
                    execFile('git', ['clone', gitUrl, destination], (fallbackError) => {
                        if (fallbackError) {
                            reject("Error cloning project: " + fallbackError.message)
                        } else {
                            resolve(true)
                        }
                    })
                } else {
                    reject("Error cloning project: " + error.message)
                }
            } else {
                resolve(true)
            }
        })
    })
}

async function getModuleBranch(module) {
    const dir = getModuleDir(module)
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim()
}

async function buildAndUp(module, coin, network, overwriteContainerId = null, onlyExecution = false, dockerCmdArgs = null) {
    if (!checkIfModuleExists(module)) {
        throw "module not found"
    }

    const environmentVariables = await getDefaultConfig(module, coin, network)
    const dir = getModuleDir(module)

    // Stage any bundled library modules into this service's build context.
    // The service's Dockerfile COPYs them in and npm resolves the
    // "file:./<lib>" deps recursively at install.
    const bundledLibs = LIBRARY_BUNDLES[module] || []
    for (const lib of bundledLibs) {
        // Always re-clone so bundled-library commits land on every `update`.
        // The previous "clone only if missing" check meant xchain-vm changes
        // got silently ignored on `update xchain-indexer` because the cached
        // modules/xchain-vm dir from a prior run was reused verbatim.
        // cloneGit(rewrite=true) removes any existing dir before cloning.
        console.log("Cloning bundled library " + lib + " for " + module)
        await cloneGit(lib, true, false, null)
        const libSrc  = getModuleDir(lib)
        const libDest = path.join(dir, lib)
        console.log("Staging " + lib + " into " + module + " build context")
        fs.rmSync(libDest, { recursive: true, force: true })
        fs.cpSync(libSrc, libDest, {
            recursive: true,
            force: true,
            filter: (src) => {
                const base = path.basename(src)
                return base !== "node_modules" && base !== ".git" &&
                       base !== "test" && base !== "bench" && base !== "reports"
            }
        })
    }

    return new Promise((resolve, reject) => {
        // With execFile, env vars are passed as individual array elements — no shell escaping needed
        const envArgs = []
        for (const key in environmentVariables) {
            envArgs.push('-e', `${key}=${String(environmentVariables[key])}`)
        }

        const containerPrefix = getDockerContainerImageName(module, coin, network)

        console.log("Building image of module " + module + (coin && network ? " in " + coin + " " + network : ""))
        execFile('docker', ['build', '.', '-t', containerPrefix], { cwd: dir }, async (error) => {
            if (error) {
                reject("Error creating Docker image: " + error.message)
                return
            }

            try {
                const portArgs = []
                const volumeArgs = []
                const ulimitArgs = []

                switch (module) {
                    case XChainService.XCHAIN_DECODER:
                        if ("DECODER_PORT" in environmentVariables && "DECODER_API_PORT" in environmentVariables) {
                            portArgs.push('-p', `${environmentVariables["DECODER_PORT"]}:${environmentVariables["DECODER_API_PORT"]}`)
                        }
                        volumeArgs.push('-v', `${environmentVariables["DECODER_BOOTSTRAP_VOLUME"]}:/bootstrap/xchain-decoder`)
                        break
                    case XChainService.XCHAIN_ENCODER:
                        if ("ENCODER_PORT" in environmentVariables && "ENCODER_API_PORT" in environmentVariables) {
                            portArgs.push('-p', `${environmentVariables["ENCODER_PORT"]}:${environmentVariables["ENCODER_API_PORT"]}`)
                        }
                        break
                    case XChainService.XCHAIN_UTXO_TRACKER:
                        if ("UTXO_TRACKER_PORT" in environmentVariables && "UTXO_TRACKER_API_PORT" in environmentVariables) {
                            portArgs.push('-p', `${environmentVariables["UTXO_TRACKER_PORT"]}:${environmentVariables["UTXO_TRACKER_API_PORT"]}`)
                        }
                        volumeArgs.push(
                            '-v', `${module}${SEP}${coin}-${network}-data:/data/xchain-utxo-tracker`,
                            '-v', `${environmentVariables["UTXO_TRACKER_BOOTSTRAP_VOLUME"]}:/bootstrap/xchain-utxo-tracker`
                        )
                        ulimitArgs.push('--ulimit', 'nofile=2048:2048')
                        break
                    case XChainService.XCHAIN_INDEXER:
                        if ("INDEXER_PORT" in environmentVariables && "INDEXER_API_PORT" in environmentVariables) {
                            portArgs.push('-p', `${environmentVariables["INDEXER_PORT"]}:${environmentVariables["INDEXER_API_PORT"]}`)
                        }
                        break
                    case XChainService.XCHAIN_REGTEST_MINER:
                        if ("REGTEST_MINER_PORT" in environmentVariables) {
                            portArgs.push('-p', `${environmentVariables["REGTEST_MINER_PORT"]}:${environmentVariables["REGTEST_MINER_API_PORT"]}`)
                        }
                        break
                    case 'xchain-hub':
                        coin = ""
                        network = ""
                        portArgs.push('-p', `${environmentVariables["HUB_PORT"]}:${environmentVariables["HUB_PORT"]}`)
                        // Validator mode: mount the capability config (read-only) so the
                        // hub's HUB_CAPABILITY_CONFIG path resolves inside the container.
                        // No-op for a standalone hub (no validator configured).
                        if ("HUB_CAPABILITY_CONFIG" in environmentVariables) {
                            const { getCapabilityConfigHostPath, CAPS_CONTAINER_PATH } = require('./ValidatorService')
                            const capsHost = getCapabilityConfigHostPath()
                            if (capsHost) {
                                volumeArgs.push('-v', `${capsHost}:${CAPS_CONTAINER_PATH}:ro`)
                            }
                        }
                        // Operator signer for the on-chain DOGE publishers (PRICE v0 /
                        // ANCHOR). The directory carries the operator's signer.js plus
                        // its own node_modules and key file, so the whole directory is
                        // mounted read-only; ConfigService sets HUB_SIGNER_MODULE to the
                        // matching in-container path. No-op when unconfigured.
                        if (process.env.XCHAIN_NODE_HUB_SIGNER_DIR && fs.existsSync(process.env.XCHAIN_NODE_HUB_SIGNER_DIR)) {
                            volumeArgs.push('-v', `${process.env.XCHAIN_NODE_HUB_SIGNER_DIR}:/XChainHub/operator-signer:ro`)
                        }
                        break
                    case EXPLORER_MODULE_NAME:
                        coin = ""
                        network = ""
                        portArgs.push(
                            '-p', `${environmentVariables["EXPLORER_PORT_HTTP"]}:${environmentVariables["EXPLORER_API_PORT_HTTP"]}`,
                            '-p', `${environmentVariables["EXPLORER_PORT_HTTPS"]}:${environmentVariables["EXPLORER_API_PORT_HTTPS"]}`
                        )
                        break
                    case SYNC_MODULE_NAME:
                        coin = ""
                        network = ""
                        if ("SYNC_PORT" in environmentVariables && "SYNC_API_PORT" in environmentVariables) {
                            portArgs.push('-p', `${environmentVariables["SYNC_PORT"]}:${environmentVariables["SYNC_API_PORT"]}`)
                        }
                        break
                }

                // Validate all port values
                if (portArgs.length > 0) {
                    for (let i = 0; i < portArgs.length; i++) {
                        if (portArgs[i] === '-p') {
                            const pair = portArgs[i + 1]
                            const colonIdx = pair.indexOf(':')
                            if (colonIdx === -1) continue
                            const hostPort = pair.substring(0, colonIdx)
                            const containerPort = pair.substring(colonIdx + 1)
                            if (!validatePort(hostPort) || !validatePort(containerPort)) {
                                reject("Invalid port value in configuration: " + pair)
                                return
                            }
                        }
                    }
                }

                if (overwriteContainerId) {
                    try {
                        await killContainer(overwriteContainerId)
                    } catch { /* container may not be running */ }
                    try {
                        await removeContainer(overwriteContainerId)
                    } catch { /* container may have been removed manually */ }
                }

                // One-shot execution containers (e.g. the e2e-test runner) must NOT get a
                // restart policy: after their command exits, `unless-stopped` would restart
                // them, re-running the suite and leaving the container "restarting" so the
                // subsequent `docker rm` fails. Persistent service containers keep the policy.
                const restartArgs = onlyExecution ? [] : ['--restart', 'unless-stopped']
                const runArgs = [
                    'run', '-d', ...restartArgs, '--name', containerPrefix, '--hostname', containerPrefix,
                    ...volumeArgs,
                    ...ulimitArgs,
                    '--network', getDockerNetwork(coin, network),
                    ...envArgs,
                    ...portArgs,
                    '-t', containerPrefix,
                    ...(dockerCmdArgs ?? [])
                ]

                console.log("Creating container of module " + module + (coin && network ? " in " + coin + " " + network : ""))
                execFile('docker', runArgs, { cwd: dir }, async (error2, stdout) => {
                    if (error2) {
                        reject("Error creating the container: " + error2.message)
                        return
                    }
                    try {
                        const containerId = stdout.trim()
                        if (/^[a-f0-9]{64}$/.test(containerId)) {
                            if (!onlyExecution) {
                                if (await db.insertModuleContainer(module, coin, network, containerId)) {
                                    await statusChanged()
                                    resolve(containerId)
                                } else {
                                    reject("There was a problem trying to store the container's id")
                                }
                            } else {
                                resolve(containerId)
                            }
                        } else {
                            reject("Invalid container ID returned by Docker: " + containerId)
                        }
                    } catch (err) {
                        reject(err)
                    }
                })
            } catch (err) {
                reject(err)
            }
        })
    })
}

// Singleton modules share one coin/network-independent container name (see
// getDockerContainerImageNamePrefix). DB and EXPLORER have dedicated install
// branches that are already idempotent; HUB and SYNC fall through to the
// generic branch whose "already built?" check is keyed per coin/network — which
// can't see the one shared container, so installing across multiple networks
// would re-run `docker run` with a duplicate name and crash.
const SINGLETON_MODULES = [HUB_MODULE_NAME, SYNC_MODULE_NAME]

// True if a container with this exact name already exists (running or stopped).
// Mirrors getDatabaseContainerId's inspect-by-name probe.
async function containerExistsByName(name) {
    try {
        const { stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', name])
        return /^[a-f0-9]{64}$/.test(stdout.trim())
    } catch {
        return false
    }
}

async function installModule(module, coin, network, remoteUpdate = false, overwriteContainerId = null, onlyExecution = false, branch = null, dockerCmdArgs = null) {
    if (coin === "") coin = null
    if (network === "") network = null

    const { getLocalNodeVersion, getLocalModuleVersion } = require('./VersionService')
    const { getRemoteModuleVersions, getLastStatus }     = require('../state')
    const { buildCryptoNode, getCryptoNode }             = require('./NodeService')
    const { buildDatabaseModule }                        = require('./DatabaseService')
    const { installExplorerModule }                      = require('./ExplorerService')
    const { checkRemoteNodeVersion }                     = require('./VersionService')

    if (module === NODE_MODULE_NAME) {
        const lastStatus = getLastStatus()
        const containerNodeVersion = lastStatus?.[coin ?? ""]?.[network ?? ""]?.[module]?.["container_version"] ?? null

        if (!containerNodeVersion || remoteUpdate) {
            let localNodeVersion = null
            try {
                localNodeVersion = await getLocalNodeVersion(coin, network)
            } catch { /* not installed yet */ }

            if (localNodeVersion == null || remoteUpdate) {
                try {
                    const remoteVersions = getRemoteModuleVersions()
                    if (!(NODE_MODULE_NAME + SEP + coin in remoteVersions)) {
                        await checkRemoteNodeVersion(coin)
                    }
                    const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
                    await getCryptoNode(coin, network, remoteNodeVersion)
                } catch (err) {
                    throw err
                }
            }

            await buildCryptoNode(coin, network)
            await statusChanged()
            return true
        } else {
            return false
        }
    } else if (module === DB_MODULE_NAME) {
        try {
            await buildDatabaseModule(coin, network)
            await statusChanged()
            return true
        } catch (err) {
            throw err
        }
    } else if (module === EXPLORER_MODULE_NAME) {
        try {
            // remoteUpdate=true means the user explicitly ran `update explorer`
            // (or a force-reinstall) — bypass the ping/status-row early returns
            // in installExplorerModule and tear down the existing container.
            await installExplorerModule(remoteUpdate)
            await statusChanged()
            return true
        } catch (err) {
            throw err
        }
    } else {
        // For a singleton module the container name is the same for every
        // coin/network, so once it exists this call is a redundant pass for
        // another network in the same install run — skip it (an explicit
        // `update`, remoteUpdate=true, still rebuilds). Without this guard the
        // second network's `docker run` collides on the existing name.
        if (SINGLETON_MODULES.includes(module) && !remoteUpdate) {
            if (await containerExistsByName(getDockerContainerImageName(module, coin, network))) {
                return false
            }
        }

        const lastStatus = getLastStatus()
        const containerNodeVersion = lastStatus?.[coin ?? ""]?.[network ?? ""]?.[module]?.["container_version"] ?? null

        if (!containerNodeVersion || remoteUpdate) {
            let localModuleVersion = null
            try {
                localModuleVersion = await getLocalModuleVersion(module)
            } catch { /* not installed yet */ }

            try {
                if (remoteUpdate || localModuleVersion == null) {
                    await cloneGit(module, true, false, branch)
                } else if (branch && moduleDirExists(module)) {
                    const currentBranch = await getModuleBranch(module)
                    if (currentBranch !== branch) {
                        console.log(`Module '${module}' is on branch '${currentBranch}', switching to '${branch}'...`)
                        await cloneGit(module, true, false, branch)
                    }
                }
                // Fresh-install detection must happen BEFORE buildAndUp starts the
                // tracker (a fresh tracker creates an empty LevelDB immediately).
                let utxoWasFresh = false
                if (module === XChainService.XCHAIN_UTXO_TRACKER && !onlyExecution) {
                    const { utxoTrackerVolumeHasData } = require('./BootstrapService')
                    utxoWasFresh = !(await utxoTrackerVolumeHasData(coin, network))
                }
                // Decoder/indexer freshness must also be sampled BEFORE buildAndUp —
                // once the service starts it fills its `blocks` table, which would
                // make a fresh install look populated.
                let mariaWasFresh = false
                if ((module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) && !onlyExecution) {
                    const { mariaDbModuleHasData } = require('./BootstrapService')
                    mariaWasFresh = !(await mariaDbModuleHasData(coin, network, module))
                }
                const containerId = await buildAndUp(module, coin, network, overwriteContainerId, onlyExecution, dockerCmdArgs)
                if (module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) {
                    await setDatabaseParameters()
                }
                if (utxoWasFresh) {
                    const { ensureBootstrapUtxoTracker } = require('./BootstrapService')
                    await ensureBootstrapUtxoTracker(coin, network)
                }
                if (mariaWasFresh) {
                    const { ensureBootstrapMariaDb } = require('./BootstrapService')
                    await ensureBootstrapMariaDb(coin, network, module)
                }
                if (!onlyExecution) await statusChanged()
                return containerId
            } catch (err) {
                throw err
            }
        } else {
            return false
        }
    }
}

async function uninstallModule(coin, network, module) {
    const { DB_MODULE_NAME } = require('../config/constants')
    const modulesStatus = await getStatus(null, null, false)

    if (module === DB_MODULE_NAME) {
        throw "The database must be manually removed"
    }

    const moduleStatus = modulesStatus?.[(coin ?? "")]?.[(network ?? "")]?.[module]
    if (moduleStatus !== undefined) {
        console.log("Uninstalling " + module + " (" + coin + "/" + network + ")")
        try {
            if (moduleStatus["status"]["State"]["Status"] !== "exited") {
                await killContainer(moduleStatus["container_id"])
            }
            await removeContainer(moduleStatus["container_id"])
            await statusChanged()
            const removed = await db.removeModuleContainer(module, coin, network)
            if (removed) {
                return removed
            } else {
                throw "There was a problem trying to remove a container from the database"
            }
        } catch {
            throw "There was a problem trying to kill a container"
        }
    } else {
        // No live container found for this module (already removed, or never
        // built). A stale row can still linger in the `modules` tracking table
        // — e.g. the container was `docker rm`'d out of band — which silently
        // makes a later install/update misbehave. getStatus probes every tracked
        // container and drops the ones that are gone, so reaching here means the
        // container truly isn't present: clean up any orphaned row.
        const staleId = await db.getModuleContainer(module, coin, network)
        if (staleId) {
            await db.removeModuleContainer(module, coin, network)
            await statusChanged()
            console.log("Removed stale tracking row for " + module + " (" + coin + "/" + network + ")")
        }
        return true
    }
}

module.exports = {
    cloneGit,
    getModuleBranch,
    buildAndUp,
    installModule,
    uninstallModule
}
