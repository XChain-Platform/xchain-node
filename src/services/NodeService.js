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
 * XChain Node - Node Service
 * Download, build and install cryptocurrency nodes
 ********************************************************************/

const { execFile } = require('child_process')
const { https } = require('follow-redirects')
const dns       = require('dns')
const fs        = require('fs')
const path      = require('path')
const semver    = require('semver')

const {
    NODE_MODULE_NAME, NODE_VERSION_FILE_NAME, SEP,
    Coin, Network, XChainService
} = require('../config/constants')
const nodeVersion = process.versions.node

// Shutdown budget for a chain daemon container, in seconds. A daemon flushes
// its block index and chainstate only on a clean shutdown, and a mainnet
// bitcoind with a large dbcache can take minutes to do it. `docker stop`
// returns as soon as the process exits, so a wide budget costs nothing on the
// common path and only matters when the flush is genuinely slow.
const NODE_STOP_TIMEOUT_SECONDS = 600

const { gitHubDownloader, db, getRemoteModuleVersions } = require('../state')
const { decompressTarGz }               = require('../utils/helpers')
const { cryptoNodesDir }                = require('../config/constants')

// The repo's own crypto_nodes tree, which ships each coin's Dockerfile and conf
// templates in git. Deliberately NOT a constant sourced from config/constants and
// NOT env-overridable: cryptoNodesDir says where a node is BUILT and may point at
// a separate volume, while this says where the build scaffold is READ FROM, which
// is always the source tree. Conflating the two is the bug this pair exists to
// prevent.
const bundledCryptoNodesDir = path.join(__dirname, '..', '..', 'crypto_nodes')
const { getDockerContainerImageName, getDockerNetwork, getDefaultConfig, validatePort } = require('./ConfigService')
const { statusChanged }                 = require('./StatusService')
const { checkRemoteNodeVersion }        = require('./VersionService')

// Enumerate a host's mirror addresses so a failover can dial one of them.
// Pinning the address changes nothing else: URL, SNI and certificate checks
// still run against the hostname. Returns [] when resolution fails.
async function resolveMirrorAddresses(hostname) {
    try {
        const records = await dns.promises.lookup(hostname, { all: true })
        return records.map((r) => ({ address: r.address, family: r.family }))
    } catch {
        return []
    }
}

// Only a transport failure is worth another mirror: every mirror answers an
// HTTP status alike. Flagged on the error rather than matched from its
// message, which is wrapped by the time it is read.
function isTransportFailure(err) {
    return err instanceof Error && err.transportFailure === true
}

// Answer dns.lookup with the one pinned address, in both callback shapes.
// autoSelectFamily (default since Node 20) calls it with `all: true` and
// requires an ARRAY; the single-address form fails the connect before it dials.
function pinnedLookup(pinned) {
    return (hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: pinned.address, family: pinned.family }])
        return cb(null, pinned.address, pinned.family)
    }
}

// One download attempt against one mirror address (or the default resolver
// when `pinned` is null). Resolves once the tarball is fully written.
function downloadTarball(downloadUrl, filePath, pinned) {
    return new Promise((resolve, reject) => {
        // No options argument unpinned: the common path keeps the plain
        // https.get shape and does no name resolution of its own.
        const options = pinned ? { lookup: pinnedLookup(pinned) } : null
        const target = pinned ? `${downloadUrl} via ${pinned.address}` : downloadUrl
        const file = fs.createWriteStream(filePath)
        let settled = false
        const fail = (err, transportFailure = true) => {
            if (settled) return
            settled = true
            file.destroy()
            // Name the URL, the mirror dialled and the cause: a broken mirror is
            // otherwise indistinguishable from a broken installer.
            const wrapped = new Error(`Bitcoin Core download failed from ${target}: ${err.message}`, { cause: err })
            wrapped.transportFailure = transportFailure
            reject(wrapped)
        }

        const onResponse = (response) => {
            // Fail closed on a non-success response (404 / redirect to an
            // error page / etc.) instead of piping an HTML error body into
            // the tarball and only discovering it later.
            if (response.statusCode !== 200) {
                response.resume() // drain
                fail(new Error(`HTTP ${response.statusCode}`), false)
                return
            }
            response.pipe(file)
            response.on("error", fail)
            file.on("error", fail)
            file.on("finish", () => {
                if (settled) return
                settled = true
                file.close()
                resolve(true)
            })
        }

        const request = options ? https.get(downloadUrl, options, onResponse) : https.get(downloadUrl, onResponse)

        // Surface transport-level failures (DNS, connection reset, TLS) as a
        // rejection instead of leaving the promise to hang forever.
        request.on("error", fail)
    })
}

async function getCryptoNode(coin, network, version) {
    if (coin === Coin.BITCOIN) {
        if (version.startsWith("v")) version = version.substring(1)

        console.log("Downloading bitcoin node...")
        const destination = cryptoNodesDir + "/bitcoin"
        const filePath = destination + "/bitcoin" + version + ".tar.gz"

        // The default crypto_nodes/bitcoin ships in the repo, but a custom
        // XCHAIN_NODE_CRYPTO_NODES_DIR (the documented big-volume setup)
        // starts empty, and createWriteStream does not create directories.
        fs.mkdirSync(destination, { recursive: true })
        // Pick the right prebuilt tarball for the host architecture.
        // bitcoincore.org publishes x86_64-linux-gnu and aarch64-linux-gnu builds.
        const archMap = { x64: 'x86_64', arm64: 'aarch64' }
        const arch = archMap[process.arch]
        if (!arch) throw new Error("Unsupported architecture for Bitcoin Core download: " + process.arch)
        const downloadUrl = "https://bitcoincore.org/bin/bitcoin-core-" + version + "/bitcoin-" + version + "-" + arch + "-linux-gnu.tar.gz"

        // Honour a tarball the operator placed here, which is the only route left
        // when every resolved mirror serves a broken certificate chain.
        // Hash-checked here so a corrupt leftover is discarded and re-downloaded
        // rather than failing the install; the verify below still gates every path.
        const failures = []
        let downloaded = false
        if (fs.existsSync(filePath)) {
            try {
                await gitHubDownloader.verifyFileHash(filePath, 'bitcoin/bitcoin', 'v' + version, arch)
                console.log(`Using the bitcoin node tarball already at ${filePath}: it matches the pinned SHA-256.`)
                downloaded = true
            } catch {
                console.log(`Discarding the file at ${filePath}: it does not match the pinned SHA-256.`)
                try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
            }
        }
        // One attempt at the resolver's choice; only a transport failure widens
        // into a mirror-by-mirror search, so a healthy install pays nothing.
        try {
            if (!downloaded) {
                await downloadTarball(downloadUrl, filePath, null)
                downloaded = true
            }
        } catch (err) {
            failures.push(err.message)
            // A partial file would otherwise be hashed as if it were the download.
            try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
            if (!isTransportFailure(err)) throw err

            const mirrors = await resolveMirrorAddresses(new URL(downloadUrl).hostname)
            for (const pinned of mirrors) {
                console.log(`Retrying the bitcoin node download via mirror ${pinned.address}...`)
                try {
                    await downloadTarball(downloadUrl, filePath, pinned)
                    downloaded = true
                    break
                } catch (retryErr) {
                    failures.push(retryErr.message)
                    try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
                }
            }
        }
        if (!downloaded) {
            throw new Error(
                "Couldn't download the bitcoin node. Every mirror for " + downloadUrl + " failed:\n  " +
                failures.join("\n  ") +
                "\nIf these are certificate errors the mirror is serving an incomplete chain, not your CA store," +
                " and every address your resolver returns can be serving the same one." +
                " Fetch the tarball with curl (which recovers the missing intermediate where Node cannot), put it at " + filePath +
                ", and re-run install: a tarball already at that path is used as-is, and its pinned SHA-256 is still verified before it is used."
            )
        }

        try {
            // Supply-chain guard: bitcoind is a prebuilt binary fetched
            // straight from bitcoincore.org over the wire. Verify the
            // downloaded tarball against the project's published
            // SHA-256 (github_hashes.json, sourced from the GPG-signed
            // SHA256SUMS) BEFORE decompressing, so a tampered or
            // truncated download can never reach the build/run path.
            // Fails closed: unknown version/arch or any mismatch throws.
            await gitHubDownloader.verifyFileHash(filePath, 'bitcoin/bitcoin', 'v' + version, arch)

            console.log("Decompressing bitcoin node files...")
            await decompressTarGz(filePath)

            if (fs.existsSync(destination + "/bitcoin")) {
                if (semver.gte(nodeVersion, "14.14.0")) {
                    fs.rmSync(destination + "/bitcoin", { recursive: true, force: true })
                } else {
                    fs.rmdirSync(destination + "/bitcoin", { recursive: true })
                }
            }

            fs.renameSync(destination + "/bitcoin-" + version, destination + "/bitcoin")
            fs.writeFileSync(destination + "/bitcoin/" + NODE_VERSION_FILE_NAME, version)
        } catch (err) {
            // Remove the unverified/failed tarball so a later retry
            // re-downloads cleanly instead of trusting a cached bad file.
            try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
            throw err
        }
    } else if (coin === Coin.DOGECOIN) {
        await gitHubDownloader.downloadRepoVersion("dogecoin", "dogecoin", version, { outputPath: cryptoNodesDir + "/dogecoin" })
    } else if (coin === Coin.LITECOIN) {
        await gitHubDownloader.downloadRepoVersion("litecoin-project", "litecoin", version, { outputPath: cryptoNodesDir + "/litecoin" })
    } else {
        throw new Error("There's no support for " + coin + " in " + network + " network yet")
    }
    return true
}

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
// regtest use a subdir. Litecoin moved its testnet to `testnet4`; Bitcoin and
// Dogecoin use `testnet3`.
function nodeNetworkSubdir(coin, network) {
    if (network === 'mainnet') return ''
    if (network === 'regtest') return '/regtest'
    return coin === 'litecoin' ? '/testnet4' : '/testnet3'
}

// Resolve the relocated-blocks root. The env var wins and, when present, is
// persisted to the config/node.local sidecar so later invocations that lack it
// (non-interactive SSH, cron: the profile is never sourced) inherit the same
// value instead of silently building mount-less containers (this was found
// via a real crash-loop). With no env var the sidecar value applies.
// Returns null when neither source has a value (in-datadir layout).
async function resolveBlocksDir() {
    const { configDir } = require('../config/constants')
    const { readSidecarValue, upsertSidecarValues } = require('./ConfigService')
    const sidecarPath = path.resolve(configDir, 'node.local')
    const envValue = process.env.XCHAIN_NODE_BLOCKS_DIR
    if (envValue && envValue.trim() !== '') {
        const value = envValue.trim()
        try {
            if (await readSidecarValue(sidecarPath, 'XCHAIN_NODE_BLOCKS_DIR') !== value) {
                upsertSidecarValues(sidecarPath, { XCHAIN_NODE_BLOCKS_DIR: value })
            }
        } catch (err) {
            // Persistence is a convenience; the env value still applies this run.
            console.error('Warning: could not persist XCHAIN_NODE_BLOCKS_DIR to ' + sidecarPath + ': ' + err.message)
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

async function buildCryptoNode(coin, network, bitcoinVer = null) {
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
    // image build). Lazy require avoids a load-time cycle with ModuleService.
    if (defaultExposedPort && defaultNodePort) {
        const { assertNoHostPortConflicts } = require('./ModuleService')
        await assertNoHostPortConflicts(['-p', `${defaultExposedPort}:${defaultNodePort}`], containerPrefix)
    }

    return new Promise((resolve, reject) => {
        console.log("Building image of " + coin + " " + network + " node")
        execFile('docker', ['build', '.', '--build-arg', 'CONF_FILE=' + confFileName, '-t', containerPrefix], { cwd: nodeDir }, async (error) => {
            if (error) {
                console.error("Error creating Docker image: " + error.message)
                reject("Error creating Docker image: " + error.message)
                return
            }

            const { dataDir } = require('../config/constants')
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
                return
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

            // Mount-drift guard: if the container being replaced has bind mounts
            // the new spec lacks, refuse BEFORE removing it. A real crash-loop
            // came from exactly this: an env-less rebuild dropped the relocated
            // blocks/txindex mounts, so the daemon restarted over an empty
            // blocks store with a current chainstate.
            const { forceRemoveContainerByName, getContainerBindMounts, stopContainerByName } = require('./DockerService')
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
                return
            }

            // Stop the running daemon cleanly BEFORE the force-remove below:
            // `docker rm -f` is SIGKILL, and a killed daemon restarts at its last
            // flushed block index. The regtest litecoind rehearsal of the
            // v0.21.5.6 bump lost 16 mined blocks that way (2026-09-03); a
            // mainnet node would face a long replay or a corrupt store instead.
            await stopContainerByName(containerPrefix, NODE_STOP_TIMEOUT_SECONDS)

            // Name-keyed cleanup immediately before `docker run --name`, making
            // (re)creation idempotent against a leftover carcass unregistered by
            // an insert-failure at the tail of this function (see reject() below)
            // or an interrupted earlier run. Unlike ModuleService.buildAndUp, this
            // path had no cleanup at all before a name collision (uuid:9533ee7a).
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
                    return
                }
            }
            const runArgs = [
                'run', '-d',
                '--restart', 'unless-stopped',
                '--name', containerPrefix,
                // Same shutdown budget for an operator's `docker stop`/`restart`
                // and for dockerd's own shutdown: the default 10 s is far too
                // short for a chain daemon to flush.
                '--stop-timeout', String(NODE_STOP_TIMEOUT_SECONDS),
                // Cap json-file log growth so a long-running node cannot fill
                // the host disk, at the same 50m x 4 = 200 MB the module
                // containers carry (ModuleService.buildAndUp holds the sizing
                // arithmetic; spec proactive-system-watch, 2.0.5). Chain nodes
                // are the quietest containers measured on regtest (686 B/h BTC,
                // 4.4 KB/h DOGE, 2.5 KB/h LTC on 2026-08-30), so this is far
                // past the 48 h floor even allowing for a mainnet node's much
                // heavier P2P chatter. --tail reads stay inside one rotated file.
                '--log-opt', 'max-size=50m', '--log-opt', 'max-file=4',
                '--hostname', NODE_MODULE_NAME,
                '--network-alias', NODE_MODULE_NAME,
                '--ulimit', 'nofile=2048:2048',
                '--network', getDockerNetwork(coin, network)
            ]
            for (const mount of volumeMounts) {
                runArgs.push('-v', mount.spec)
            }
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
                    return
                }
                if (!validatePort(defaultNodePort)) {
                    reject(new Error("Invalid port value in configuration: NODE_PORT=" + defaultNodePort))
                    return
                }
                runArgs.push('-p', `${defaultExposedPort}:${defaultNodePort}`)
            }
            runArgs.push('-e', `CRYPTO_NODE_VERSION=${bitcoinVer}`, '-t', containerPrefix)
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

            console.log("Creating container of " + coin + " " + network + " node")
            execFile('docker', runArgs, { cwd: nodeDir }, async (error2, stdout) => {
                if (error2) {
                    reject("Error creating the container: " + error2.message)
                    return
                }
                try {
                    const containerId = stdout.trim()
                    if (/^[a-f0-9]{64}$/.test(containerId)) {
                        if (await db.insertModuleContainer(NODE_MODULE_NAME, coin, network, containerId)) {
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
        })
    })
}

// Optional exact-version pin for a coin daemon, read from
// XCHAIN_NODE_NODE_VERSION_<COIN> (e.g. XCHAIN_NODE_NODE_VERSION_LITECOIN=v0.21.4).
// Test harnesses (notably the multi-chain parity sweep) set this so the
// installed daemon matches the DEPLOYED fleet image instead of drifting to the
// latest upstream release. Returns null when no pin is set.
function resolveNodeVersionPin(coin) {
    const pin = process.env['XCHAIN_NODE_NODE_VERSION_' + String(coin).toUpperCase()]
    return pin && pin.trim() !== '' ? pin.trim() : null
}

// Enforce a version pin against an already-installed local daemon. A silent
// mismatch would defeat the pin (installNode skips the download when a local
// copy exists), so fail loudly with the remediation instead.
function assertNodeVersionPin(coin, network, localNodeVersion, pin) {
    if (pin && localNodeVersion != null && localNodeVersion !== pin) {
        throw new Error(
            `Installed ${coin} node is ${localNodeVersion} but ` +
            `XCHAIN_NODE_NODE_VERSION_${String(coin).toUpperCase()} pins ${pin}. ` +
            `Remove the ${coin}/${network} stack (or the cached crypto node) and reinstall.`)
    }
}

async function installNode(coin, network) {
    console.log("Creating xchain docker network...")
    const { createDockerNetwork } = require('./DockerService')
    const { getDockerNetwork } = require('./ConfigService')
    await createDockerNetwork(getDockerNetwork(coin, network))

    console.log("Installing database...")
    const { buildDatabaseModule } = require('./DatabaseService')
    await buildDatabaseModule(coin, network)

    console.log("Installing " + coin + " " + network + " node...")
    const { getLocalNodeVersion } = require('./VersionService')
    let localNodeVersion = null
    try {
        localNodeVersion = await getLocalNodeVersion(coin, network)
    } catch { /* not installed */ }

    const versionPin = resolveNodeVersionPin(coin)
    assertNodeVersionPin(coin, network, localNodeVersion, versionPin)

    if (localNodeVersion == null) {
        if (versionPin) {
            console.log("Node version pinned via env: installing " + coin + " " + versionPin)
            await getCryptoNode(coin, network, versionPin)
        } else {
            if (!(NODE_MODULE_NAME + SEP + coin in getRemoteModuleVersions())) {
                await checkRemoteNodeVersion(coin)
            }
            const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
            if (remoteNodeVersion != null) {
                await getCryptoNode(coin, network, remoteNodeVersion)
            } else {
                throw new Error("There is no valid version to download for the " + coin + "/" + network + " node")
            }
        }
    }
    await buildCryptoNode(coin, network)

    const { cloneGit, buildAndUp } = require('./ModuleService')

    console.log("Downloading xchain-encoder...")
    await cloneGit(XChainService.XCHAIN_ENCODER, true)
    console.log("Building xchain-encoder container...")
    await buildAndUp(XChainService.XCHAIN_ENCODER, coin, network)

    console.log("Downloading xchain-decoder...")
    await cloneGit(XChainService.XCHAIN_DECODER, true)
    console.log("Building xchain-decoder container...")
    await buildAndUp(XChainService.XCHAIN_DECODER, coin, network)

    console.log("Downloading xchain-utxo-tracker...")
    await cloneGit(XChainService.XCHAIN_UTXO_TRACKER, true)
    console.log("Building xchain-utxo-tracker...")
    const { utxoTrackerVolumeHasData, ensureBootstrapUtxoTracker, forceBootstrapRequested } = require('./BootstrapService')
    const utxoWasFresh = !(await utxoTrackerVolumeHasData(coin, network)) || forceBootstrapRequested()
    await buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (utxoWasFresh) await ensureBootstrapUtxoTracker(coin, network)

    if (network === Network.REGTEST) {
        console.log("Downloading xchain-regtest-miner...")
        await cloneGit(XChainService.XCHAIN_REGTEST_MINER, true)
        console.log("Building xchain-regtest-miner...")
        await buildAndUp(XChainService.XCHAIN_REGTEST_MINER, coin, network)
    }

    console.log("Downloading xchain-indexer...")
    await cloneGit(XChainService.XCHAIN_INDEXER, true)
    console.log("Building xchain-indexer...")
    await buildAndUp(XChainService.XCHAIN_INDEXER, coin, network)

    try {
        const { setDatabaseParameters } = require('./DatabaseService')
        await setDatabaseParameters()
    } catch (e) {
        // setDatabaseParameters is the ONLY step that force-sets the live decoder/indexer
        // MariaDB accounts to the per-install passwords getDefaultConfig just minted and
        // baked into the container env. If it fails, both containers are already up with a
        // password that exists nowhere in the DB (ER_ACCESS_DENIED crash-loop), so the
        // install has NOT succeeded. Fail loudly (matching installNode's throw-on-error
        // convention) rather than logging a warning and returning true.
        throw new Error("Node install failed: could not set database parameters, so the decoder/indexer would be locked out of MariaDB: " + (e && e.message ? e.message : e))
    }

    await statusChanged()
    return true
}

module.exports = {
    getCryptoNode,
    buildCryptoNode,
    stageBuildScaffold,
    installNode,
    resolveBlocksDir,
    resolveNodeVersionPin,
    assertNodeVersionPin
}
