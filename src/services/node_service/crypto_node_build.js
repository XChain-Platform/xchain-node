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
 * XChain Node - Node Service: coin node build
 * Blocks dir resolution, build scaffold staging and the coin node image build
 ********************************************************************/

const { execFile } = require('child_process')
const fs        = require('fs')
const path      = require('path')

const { NODE_MODULE_NAME, cryptoNodesDir } = require('../../config')
const { db } = require('../../state')

// The repo's own crypto_nodes tree, which ships each coin's Dockerfile and conf
// templates in git. Deliberately NOT a constant sourced from config/constants and
// NOT env-overridable: cryptoNodesDir says where a node is BUILT and may point at
// a separate volume, while this says where the build scaffold is READ FROM, which
// is always the source tree. Conflating the two is the bug this pair exists to
// prevent.
const bundledCryptoNodesDir = path.join(__dirname, '../../../crypto_nodes')
const { getDockerContainerImageName, getDockerNetwork, getDefaultConfig, validatePort } = require('../config_service')
const { statusChanged }                 = require('../status_service')
const config = require('../../config');
// Destructured where they are used, so each call reads the export at that moment.
const dockerService = require('../docker_service')
const configService = require('../config_service')
// The peer table names files beside src/services, one directory up from this part.
const peers = require('../peer_services').bindPeerServices((file) => require(path.join('..', file)))
const { getLogger } = require('../../observability/logger');
const logger = getLogger();
const { nodeStopTimeoutSeconds, describeNodeStopOutcome, nodeStoppedUnclean } = require('./node_stop.js')

// Whether the coin's pinned daemon honors `-blocksdir`. Dogecoin Core (v1.14.x)
// is based on a pre-0.18 Bitcoin Core and silently ignores the flag (added
// upstream in Bitcoin Core 0.18); Bitcoin (v31) and Litecoin (v0.21) both honor
// it. For a daemon that ignores it, blocks are relocated by bind-mounting the
// external path straight onto the in-datadir blocks directory instead.
function daemonSupportsBlocksdir(coin) {
    return coin !== 'dogecoin'
}

// The network-specific subdirectory a daemon writes chain data under, relative
// to the datadir root. Mainnet writes directly under the datadir; testnet and
// regtest use a subdir. Bitcoin Core 28+ (pinned v28.1 here, see
// bitcoin-testnet.conf's testnet4=1) and Litecoin both moved their testnet to
// `testnet4`; Dogecoin (pinned v1.14.9, testnet=1) still uses `testnet3`.
function nodeNetworkSubdir(coin, network) {
    if (network === 'mainnet') return ''
    if (network === 'regtest') return '/regtest'
    return coin === 'dogecoin' ? '/testnet3' : '/testnet4'
}

// Resolve the relocated-blocks root. The env var wins and, when present, is
// persisted to the config/node.local sidecar so later invocations that lack it
// (non-interactive SSH, cron: the profile is never sourced) inherit the same
// value instead of silently building mount-less containers (this was found
// via a real crash-loop). With no env var the sidecar value applies.
// Returns null when neither source has a value (in-datadir layout).
async function resolveBlocksDir() {
    const { configDir } = config
    const { readSidecarValue, upsertSidecarValues } = configService
    const sidecarPath = path.resolve(configDir, 'node.local')
    const envValue = config.XCHAIN_NODE_BLOCKS_DIR
    if (envValue && envValue.trim() !== '') {
        const value = envValue.trim()
        try {
            if (await readSidecarValue(sidecarPath, 'XCHAIN_NODE_BLOCKS_DIR') !== value) {
                upsertSidecarValues(sidecarPath, { XCHAIN_NODE_BLOCKS_DIR: value })
            }
        } catch (err) {
            // Persistence is a convenience; the env value still applies this run.
            logger.error('Warning: could not persist XCHAIN_NODE_BLOCKS_DIR to ' + sidecarPath + ': ' + err.message)
        }
        return value
    }
    const persisted = await readSidecarValue(sidecarPath, 'XCHAIN_NODE_BLOCKS_DIR')
    return persisted && persisted.trim() !== '' ? persisted.trim() : null
}

// mkdirSync-if-absent that tolerates an existing SYMLINK. A live fix on one
// host left $BLOCKS_DIR/<coin>/<net>[-txindex] as symlinks to the real stores;
// mkdirSync({recursive}) lstat-fails through a symlink whose target the caller
// cannot traverse and surfaced as a misleading EACCES "failed to create".
// Any existing entry (dir or symlink) counts as already provisioned.
function ensureHostDir(dirPath) {
    try {
        fs.lstatSync(dirPath)
        return
    } catch { /* absent: create below */ }
    fs.mkdirSync(dirPath, { recursive: true })
}

// The image is built with the coin's own directory as the Docker context, so
// that directory must hold BOTH the downloaded daemon tree and the Dockerfile +
// conf template the repo ships in git. Only the daemon tree is downloaded there,
// so on the default layout the scaffold is present by accident: cryptoNodesDir
// already IS the repo's crypto_nodes. Point XCHAIN_NODE_CRYPTO_NODES_DIR at a
// separate volume (which the README recommends for a small root partition) and
// the build context holds nothing but the tarball, so `docker build` reports
// "failed to read dockerfile" after the whole download has already run.
//
// Copy the scaffold in before every build. Returns the conf file's basename for
// the CONF_FILE build arg. Fails closed with the missing path named, rather than
// letting docker report a two-byte build context.
function stageBuildScaffold(coin, network, nodeDir, defaultConfig) {
    const bundledCoinDir = path.join(bundledCryptoNodesDir, coin)
    const confFileName   = `${coin}-${network}.conf`

    const dockerfileSrc = path.join(bundledCoinDir, 'Dockerfile')
    const confSrc       = path.join(bundledCoinDir, confFileName)
    for (const src of [dockerfileSrc, confSrc]) {
        if (!fs.existsSync(src)) {
            throw new Error(`Missing build scaffold ${src}. The repo ships crypto_nodes/${coin}/ in git; ` +
                `this install appears to be running from an incomplete checkout.`)
        }
    }

    fs.mkdirSync(nodeDir, { recursive: true })
    if (path.resolve(nodeDir) !== path.resolve(bundledCoinDir)) {
        fs.copyFileSync(dockerfileSrc, path.join(nodeDir, 'Dockerfile'))
    }

    // The conf template ships __XCHAIN_NODE_RPC_USER__/__XCHAIN_NODE_RPC_PASSWORD__
    // placeholders. Fail closed when the provisioned credentials are missing rather
    // than baking a placeholder (or "undefined") into the image: an image whose RPC
    // credentials are the literal placeholder tokens is unreachable by every service
    // that shares them, and it fails at runtime rather than here.
    if (!defaultConfig['NODE_USER'] || !defaultConfig['NODE_PASSWORD']) {
        throw new Error(`Missing NODE_USER/NODE_PASSWORD for ${coin} ${network}; refusing to build node with placeholder RPC credentials`)
    }

    // Substitute into a generated sibling, never back into the template. The
    // template is tracked in git, so injecting in place wrote live RPC credentials
    // into a tracked file and left every built-from host with a dirty worktree
    // holding a secret. The generated name is gitignored.
    const generatedName = `${coin}-${network}.generated.conf`
    let confContent = fs.readFileSync(confSrc, 'utf8')
    confContent = confContent.replace(/^rpcuser=.*$/m,     `rpcuser=${defaultConfig['NODE_USER']}`)
    confContent = confContent.replace(/^rpcpassword=.*$/m, `rpcpassword=${defaultConfig['NODE_PASSWORD']}`)
    fs.writeFileSync(path.join(nodeDir, generatedName), confContent, { mode: 0o600 })

    return generatedName
}

async function resolveStorageMounts(coin, network, reject) {
    const { dataDir } = config
    // Env-first with config/node.local fallback (see resolveBlocksDir):
    // a profile-less invocation no longer silently reverts to the
    // in-datadir layout on a relocated-blocks host. Reject (not throw)
    // on failure: a throw in this async callback escapes the Promise
    // and hangs the build.
    let blocksDir
    try {
        blocksDir = await resolveBlocksDir()
    } catch (err) {
        reject(`XCHAIN_NODE_BLOCKS_DIR resolution failed: ${err.message}`)
        return null
    }
    // Daemons that ignore -blocksdir (dogecoin) get their blocks
    // relocated by nest-mounting onto the in-datadir blocks path, which
    // is network-specific; the others use -blocksdir against /blocks.
    const useBlocksdirFlag = daemonSupportsBlocksdir(coin)
    const netSubdir        = nodeNetworkSubdir(coin, network)
    const blocksHostPath   = blocksDir ? `${blocksDir}/${coin}/${network}` : null
    // txindex is enabled in every coin conf and stays in the datadir even
    // when blocks move (no daemon flag relocates it), so it is bind-
    // mounted onto the big disk separately. Assumes a fresh install; an
    // existing in-datadir txindex would be shadowed and rebuilt.
    const txindexHostPath  = blocksDir ? `${blocksDir}/${coin}/${network}-txindex` : null

    // The full bind-mount set of the NEW container, [{ spec, destination }],
    // composed before the old container is touched so the drift guard
    // below can compare against it.
    const volumeMounts = [
        { spec: `${dataDir}/${NODE_MODULE_NAME}/${coin}/${network}:/root/.${coin}`, destination: `/root/.${coin}` }
    ]
    if (blocksDir) {
        const blocksDest = useBlocksdirFlag
            ? '/blocks'
            // doged ignores -blocksdir: mount straight onto the blocks
            // dir it actually writes to, under the network subdir.
            : `/root/.${coin}${netSubdir}/blocks`
        volumeMounts.push({ spec: `${blocksHostPath}:${blocksDest}`, destination: blocksDest })
        // Relocate txindex for every coin (nested under the network subdir).
        const txindexDest = `/root/.${coin}${netSubdir}/indexes/txindex`
        volumeMounts.push({ spec: `${txindexHostPath}:${txindexDest}`, destination: txindexDest })
    }
    return { blocksDir, useBlocksdirFlag, blocksHostPath, txindexHostPath, volumeMounts }
}

async function prepareExistingContainer(containerPrefix, coin, network, storage, reject) {
    const { blocksDir, blocksHostPath, txindexHostPath, volumeMounts } = storage
    // Mount-drift guard: if the container being replaced has bind mounts
    // the new spec lacks, refuse BEFORE removing it. A real crash-loop
    // came from exactly this: an env-less rebuild dropped the relocated
    // blocks/txindex mounts, so the daemon restarted over an empty
    // blocks store with a current chainstate.
    const { forceRemoveContainerByName, getContainerBindMounts, stopContainerByName } = dockerService
    let existingMounts = []
    try {
        existingMounts = await getContainerBindMounts(containerPrefix)
    } catch { /* no previous container or docker unreachable: nothing to preserve */ }
    const newDestinations = new Set(volumeMounts.map(m => m.destination))
    const droppedMounts = existingMounts.filter(m => !newDestinations.has(m.destination))
    if (droppedMounts.length > 0) {
        reject(`Refusing to replace container ${containerPrefix}: the new spec would drop bind mount(s) ` +
            droppedMounts.map(m => `${m.source} -> ${m.destination}`).join(', ') +
            `. This usually means XCHAIN_NODE_BLOCKS_DIR is missing from this environment ` +
            `(non-interactive shells do not source the profile). Set it, or persist it in ` +
            `config/node.local as XCHAIN_NODE_BLOCKS_DIR=<path>, then retry. The existing container was left untouched.`)
        return null
    }

    // Stop the running daemon cleanly BEFORE the force-remove below:
    // `docker rm -f` is SIGKILL, and a killed daemon restarts at its last
    // flushed block index. The regtest litecoind rehearsal of the
    // v0.21.5.6 bump lost 16 mined blocks that way (2026-09-03); a
    // mainnet node would face a long replay or a corrupt store instead.
    const stopBudgetSeconds = nodeStopTimeoutSeconds()
    const stopOutcome = await stopContainerByName(containerPrefix, stopBudgetSeconds)
    const stopLine = describeNodeStopOutcome(coin, network, stopOutcome, stopBudgetSeconds)
    if (stopLine) {
        if (stopOutcome.killed || nodeStoppedUnclean(stopOutcome)) logger.warn(stopLine)
        else logger.info(stopLine)
    }

    // Name-keyed cleanup immediately before `docker run --name`, making
    // (re)creation idempotent against a leftover carcass unregistered by
    // an insert-failure at the tail of this function (see reject() below)
    // or an interrupted earlier run. Unlike ModuleService.buildAndUp, this
    // path had no cleanup at all before a name collision.
    try {
        await forceRemoveContainerByName(containerPrefix)
    } catch { /* tolerant by design; see DockerService.forceRemoveContainerByName */ }

    if (blocksDir) {
        try {
            ensureHostDir(blocksHostPath)
            ensureHostDir(txindexHostPath)
        } catch (err) {
            // This runs inside the async docker-build callback; a throw here
            // escapes the Promise as an uncaught exception and hangs the
            // build. Reject + return so the Promise settles instead.
            reject(`XCHAIN_NODE_BLOCKS_DIR: failed to create ${blocksHostPath}: ${err.message}`)
            return null
        }
    }
    return stopBudgetSeconds
}

function createRunArgs(coin, network, containerPrefix, stopBudgetSeconds, volumeMounts) {
    const runArgs = [
        'run', '-d', '--restart', 'unless-stopped', '--name', containerPrefix,
        // Same shutdown budget for an operator's `docker stop`/`restart`
        // and for dockerd's own shutdown: the default 10 s is far too
        // short for a chain daemon to flush.
        '--stop-timeout', String(stopBudgetSeconds),
        // Cap json-file log growth so a long-running node cannot fill
        // the host disk, at the same 50m x 4 = 200 MB the module
        // containers carry (ModuleService.buildAndUp holds the sizing
        // arithmetic). Chain nodes
        // are the quietest containers measured on regtest (686 B/h BTC,
        // 4.4 KB/h DOGE, 2.5 KB/h LTC on 2026-08-30), so this is far
        // past the 48 h floor even allowing for a mainnet node's much
        // heavier P2P chatter. --tail reads stay inside one rotated file.
        '--log-opt', 'max-size=50m', '--log-opt', 'max-file=4',
        '--hostname', NODE_MODULE_NAME, '--network-alias', NODE_MODULE_NAME,
        '--ulimit', 'nofile=2048:2048', '--network', getDockerNetwork(coin, network)
    ]
    for (const mount of volumeMounts) runArgs.push('-v', mount.spec)
    return runArgs
}

function addPortArgs(runArgs, defaultExposedPort, defaultNodePort, reject) {
    if (defaultExposedPort && defaultNodePort) {
        // NODE_EXPOSED_PORT/NODE_PORT come from the operator-supplied
        // <coin>-<network> config. Validate before the docker run push so
        // a malformed value fails loud here instead of surfacing as a
        // cryptic docker argument-parse error (matches the DB_PORT guard
        // in DatabaseService and the portArgs guard in ModuleService).
        // This runs inside the async docker-build callback; a throw here
        // escapes the Promise as an uncaught exception and hangs the
        // build (same hazard as the mkdir guard above). Reject + return
        // so the Promise settles instead.
        if (!validatePort(defaultExposedPort)) {
            reject(new Error("Invalid port value in configuration: NODE_EXPOSED_PORT=" + defaultExposedPort))
            return false
        }
        if (!validatePort(defaultNodePort)) {
            reject(new Error("Invalid port value in configuration: NODE_PORT=" + defaultNodePort))
            return false
        }
        runArgs.push('-p', `${defaultExposedPort}:${defaultNodePort}`)
    }
    return true
}

function addDaemonArgs(runArgs, coin, blocksDir, useBlocksdirFlag, containerPrefix) {
    // No CRYPTO_NODE_VERSION env: no caller ever supplied a version, so the
    // key only ever baked the literal "null" into every coin-node container
    // while nothing read it. The daemon version lives in the
    // image at /<coin>/__VERSION__.txt (VersionService.getContainerNodeVersion).
    runArgs.push('-t', containerPrefix)
    // Only daemons that honor -blocksdir need a CMD override to pass it.
    // doged relocates via the nested bind-mount above and keeps its
    // default CMD (which already references its conf).
    if (blocksDir && useBlocksdirFlag) {
        const daemonName = `${coin}d`
        const confPath = `/etc/${coin}/${coin}.conf`
        if (coin === 'bitcoin') {
            runArgs.push(daemonName, `-conf=${confPath}`, `-datadir=/root/.${coin}/`, '-blocksdir=/blocks')
        } else {
            runArgs.push(daemonName, `-conf=${confPath}`, '-blocksdir=/blocks')
        }
    }
}

function runNodeContainer(runArgs, nodeDir, coin, network, resolve, reject) {
    logger.info("Creating container of " + coin + " " + network + " node")
    execFile('docker', runArgs, { cwd: nodeDir }, async (error2, stdout) => {
        if (error2) {
            reject("Error creating the container: " + error2.message)
            return
        }
        try {
            const containerId = stdout.trim()
            if (/^[a-f0-9]{64}$/.test(containerId)) {
                if (await db.setModuleContainer(NODE_MODULE_NAME, coin, network, containerId)) {
                    await statusChanged()
                    resolve(containerId)
                } else {
                    reject("There was a problem trying to store the container's id")
                }
            } else {
                // docker run exited 0 but stdout was not a 64-char container id
                // (e.g. a warning line or unexpected output). Without this the
                // Promise would never settle and buildCryptoNode would hang.
                reject("Unexpected docker run output, no container id: " + containerId)
            }
        } catch (err) {
            reject(err)
        }
    })
}

async function buildCryptoNode(coin, network) {
    const defaultConfig = await getDefaultConfig(NODE_MODULE_NAME, coin, network)
    const defaultExposedPort = defaultConfig["NODE_EXPOSED_PORT"]
    const defaultNodePort = defaultConfig["NODE_PORT"]
    const containerPrefix = getDockerContainerImageName(NODE_MODULE_NAME, coin, network)
    const nodeDir = cryptoNodesDir + "/" + coin
    const confFileName = stageBuildScaffold(coin, network, nodeDir, defaultConfig)

    // Pre-flight host-port collision check (multi-stack hosts): same guard
    // the service- and DB-install paths use. Two different-NODE_PREFIX stacks
    // each running this coin/network node would both bind the node RPC host
    // port; without this, `docker run` fails with a cryptic "port is already
    // allocated". Runs before the build so a conflict fails fast (no wasted
    // image build). ModuleService requires this file at load, so it is read through peers.
    if (defaultExposedPort && defaultNodePort) {
        const { assertNoHostPortConflicts } = peers.moduleService
        await assertNoHostPortConflicts(['-p', `${defaultExposedPort}:${defaultNodePort}`], containerPrefix)
    }

    return new Promise((resolve, reject) => {
        logger.info("Building image of " + coin + " " + network + " node")
        execFile('docker', ['build', '.', '--build-arg', 'CONF_FILE=' + confFileName, '-t', containerPrefix], { cwd: nodeDir }, async (error) => {
            if (error) {
                logger.error("Error creating Docker image: " + error.message)
                reject("Error creating Docker image: " + error.message)
                return
            }
            const storage = await resolveStorageMounts(coin, network, reject)
            if (!storage) return
            const stopBudgetSeconds = await prepareExistingContainer(containerPrefix, coin, network, storage, reject)
            if (!stopBudgetSeconds) return
            const runArgs = createRunArgs(coin, network, containerPrefix, stopBudgetSeconds, storage.volumeMounts)
            if (!addPortArgs(runArgs, defaultExposedPort, defaultNodePort, reject)) return
            addDaemonArgs(runArgs, coin, storage.blocksDir, storage.useBlocksdirFlag, containerPrefix)
            runNodeContainer(runArgs, nodeDir, coin, network, resolve, reject)
        })
    })
}

module.exports = { bundledCryptoNodesDir, daemonSupportsBlocksdir, nodeNetworkSubdir,
    resolveBlocksDir, ensureHostDir, stageBuildScaffold, buildCryptoNode }
