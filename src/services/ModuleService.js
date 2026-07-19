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
    XChainService, SEP, modulesUrls, LIBRARY_BUNDLES, SERVICE_REGISTRY
} = require('../config/constants')
const { db }                = require('../state')
const {
    getModuleDir, getModuleTmpDir, moduleDirExists, checkIfModuleExists,
    removeModuleDir, removeModuleTmpDir, createModuleTmpDir,
    getDockerContainerImageName, getUtxoTrackerVolumeName, getDockerNetwork, getDefaultConfig, validatePort
} = require('./ConfigService')
const { statusChanged, getStatus } = require('./StatusService')
const { killContainer, removeContainer, getPublishedHostPorts, forceRemoveContainerByName } = require('./DockerService')
const { setDatabaseParameters, setHubDatabaseParameters }  = require('./DatabaseService')
const { redactSecrets } = require('../utils/helpers')

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
            reject("Invalid branch name: " + branch + " (branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes)")
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
                    // Do NOT silently fall back to the default branch: install/update
                    // callers pass `branch` as an explicit operator request (cli.js),
                    // and running different code than what was asked for with only a
                    // scrolling console.warn is a silent-wrong-code hazard
                    // (uuid:4f649bd0). Fail the clone instead.
                    reject(`Error cloning project: branch '${branch}' not found for module '${module}'`)
                } else {
                    reject("Error cloning project: " + redactSecrets(error.message))
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

// Fail fast on host-port collisions before `docker run`. On a single-stack
// host this is a no-op; on a multi-stack host (two NODE_PREFIX stacks, or a
// service container hand-created outside xchain-node) two containers can request
// the same host port, which `docker run` only surfaces as a cryptic "port is
// already allocated" AFTER the image build wastes minutes. `selfName` is the
// container we're (re)creating (excluded so re-installs/updates of the same
// service don't flag themselves; the old container is already killed+removed
// before this runs, but the name-exclusion is belt-and-suspenders).
async function assertNoHostPortConflicts(portArgs, selfName) {
    const requested = []
    for (let i = 0; i < portArgs.length; i++) {
        if (portArgs[i] === '-p') {
            const pair = portArgs[i + 1]
            if (typeof pair !== 'string') continue
            const colonIdx = pair.lastIndexOf(':')
            if (colonIdx === -1) continue
            // "-p HOST:CONTAINER" or "-p IP:HOST:CONTAINER": the host port is the
            // field before the final colon; take the last colon-separated pair's left side.
            const beforeContainer = pair.substring(0, colonIdx)
            const hostPort = beforeContainer.substring(beforeContainer.lastIndexOf(':') + 1)
            if (/^\d+$/.test(hostPort)) requested.push(hostPort)
        }
    }
    if (requested.length === 0) return

    const published = await getPublishedHostPorts()
    const conflicts = []
    for (const hostPort of requested) {
        const holders = published.get(hostPort)
        if (!holders) continue
        const others = [...holders].filter(n => n !== selfName)
        if (others.length > 0) conflicts.push({ hostPort, holders: others })
    }
    if (conflicts.length > 0) {
        const lines = conflicts.map(c => `  host port ${c.hostPort} is already published by: ${c.holders.join(', ')}`)
        throw new Error(
            'Host port conflict: cannot publish the following port(s):\n' +
            lines.join('\n') + '\n' +
            'Another stack or container already binds them on this host. Override the colliding ' +
            'port(s) in config/<coin>-<network> (e.g. EXPLORER_PORT_HTTP/HTTPS, INDEXER_PORT, HUB_PORT, ' +
            'DECODER_PORT, ENCODER_PORT, UTXO_TRACKER_PORT, SYNC_PORT) and re-run, or stop the conflicting container first.'
        )
    }
}

// Per-service healthcheck descriptors.
// Each entry specifies how Docker should probe container readiness:
//   portKey   - the env-var name whose value is the container-internal port to probe
//   probe     - 'http_get' uses wget GET on /status; 'jsonrpc_ping' uses wget POST
//               with a JSON-RPC ping payload; absent means no healthcheck added
//   interval  - how often Docker reruns the check (--health-interval)
//   timeout   - per-check timeout (--health-timeout)
//   retries   - consecutive failures before marking unhealthy (--health-retries)
//   startPeriod - grace period after container start before failures count
//                 (--health-start-period); set long enough for npm start + DB connect
//
// Timing rationale:
//   interval=15s  - frequent enough to detect a stuck service quickly without hammering
//   timeout=5s    - generous but short of the interval; covers a slow DB query
//   retries=3     - three misses (~45s) before marking unhealthy; avoids flapping
//   startPeriod=  - varies: fast workers (encoder/miner) get 30s; DB-dependent services
//                   (decoder, indexer, utxo-tracker) get 60s; hub/explorer/sync get 45s
const SERVICE_HEALTHCHECK = {
    [XChainService.XCHAIN_DECODER]:       { portKey: 'DECODER_API_PORT',       probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    [XChainService.XCHAIN_ENCODER]:       { portKey: 'ENCODER_API_PORT',       probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '30s' },
    [XChainService.XCHAIN_UTXO_TRACKER]:  { portKey: 'UTXO_TRACKER_API_PORT',  probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    [XChainService.XCHAIN_INDEXER]:       { portKey: 'INDEXER_API_PORT',        probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    // The miner's API is JSON-RPC only (no GET /status route); an http_get probe 500s
    // on every check and marks the container permanently unhealthy.
    [XChainService.XCHAIN_REGTEST_MINER]: { portKey: 'REGTEST_MINER_API_PORT',  probe: 'jsonrpc_ping', interval: '15s', timeout: '5s', retries: 3, startPeriod: '30s' },
    [HUB_MODULE_NAME]:                    { portKey: 'HUB_PORT',                probe: 'jsonrpc_ping', interval: '15s', timeout: '5s', retries: 3, startPeriod: '45s' },
    [EXPLORER_MODULE_NAME]:               { portKey: 'EXPLORER_API_PORT_HTTP',  probe: 'jsonrpc_ping', interval: '15s', timeout: '5s', retries: 3, startPeriod: '45s' },
    [SYNC_MODULE_NAME]:                   { portKey: 'SYNC_API_PORT',           probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '45s' }
    // xchain-e2e-test: one-shot execution container, never gets --restart, healthcheck not applicable
    // coin nodes (node module): managed by NodeService / crypto_nodes; not built via buildAndUp
    // database (mariadb): managed by DatabaseService with its own health tooling
}

// Build the --health-* flags for a service container's docker run invocation.
// Returns an empty array when no healthcheck is configured for the module
// (or when the required port env-var is missing), so callers are always safe.
function buildHealthcheckArgs(module, environmentVariables) {
    const hc = SERVICE_HEALTHCHECK[module]
    if (!hc) return []

    const port = environmentVariables[hc.portKey]
    if (!port) {
        // Every descriptor's portKey currently ships in ConfigService.getDefaultConfig,
        // so this guard should never fire. If a future rename or config regression drops
        // the key, the container would otherwise be created with NO healthcheck and no
        // trace of why: make that drift loud at install/update time. Empty-array return
        // is preserved so callers stay safe.
        console.log("WARNING: no healthcheck for " + module + ": env " + hc.portKey + " is unset")
        return []
    }

    let cmd
    if (hc.probe === 'jsonrpc_ping') {
        // JSON-RPC POST ping; hub, explorer, and the regtest miner all use this protocol
        cmd = `wget -qO- --post-data='{"jsonrpc":"2.0","method":"ping","id":1}' --header='Content-Type: application/json' http://localhost:${port}/ || exit 1`
    } else {
        // Default: plain HTTP GET on /status
        cmd = `wget -qO- http://localhost:${port}/status || exit 1`
    }

    return [
        '--health-cmd',      cmd,
        '--health-interval', hc.interval,
        '--health-timeout',  hc.timeout,
        '--health-retries',  String(hc.retries),
        '--health-start-period', hc.startPeriod
    ]
}

// Build the per-service docker-run port/volume/ulimit args from the
// table-driven SERVICE_REGISTRY (constants.js) instead of a hand-maintained
// switch/case. A module with no `docker` facet (or no registry entry, e.g.
// the one-shot e2e-test runner) yields empty arg arrays. `singleton` tells the
// caller to clear coin/network before container-name and network resolution
// (shared hub/explorer/sync containers). Preserves the previous exact
// semantics: `always` ports push unconditionally, other ports push only when
// both env keys are present, and the two hub-only dynamic mounts (validator
// capability config, operator signer dir) resolve here where ValidatorService
// and the filesystem are available.
function buildModuleDockerArgs(module, environmentVariables, coin, network) {
    const portArgs = []
    const volumeArgs = []
    const ulimitArgs = []
    const docker = (SERVICE_REGISTRY[module] || {}).docker
    if (!docker) return { portArgs, volumeArgs, ulimitArgs, singleton: false }

    for (const p of docker.ports || []) {
        if (p.always || (p.host in environmentVariables && p.container in environmentVariables)) {
            portArgs.push('-p', `${environmentVariables[p.host]}:${environmentVariables[p.container]}`)
        }
    }

    for (const v of docker.volumes || []) {
        if (v.hostKey) {
            volumeArgs.push('-v', `${environmentVariables[v.hostKey]}:${v.container}`)
        } else if (v.hostFn === 'utxoTrackerVolume') {
            // Volume name derivation lives in one place (ConfigService), consumed
            // here and by resetModules + BootstrapService, so a non-default
            // NODE_PREFIX can never drift between them (uuid:7523dd94, uuid:a61fc673).
            volumeArgs.push('-v', `${getUtxoTrackerVolumeName(coin, network)}:${v.container}`)
        } else if (v.type === 'hubCapabilityConfig') {
            // Validator mode: mount the capability config (read-only) so the
            // hub's HUB_CAPABILITY_CONFIG path resolves inside the container.
            // No-op for a standalone hub (no validator configured).
            if ('HUB_CAPABILITY_CONFIG' in environmentVariables) {
                const { getCapabilityConfigHostPath, CAPS_CONTAINER_PATH } = require('./ValidatorService')
                const capsHost = getCapabilityConfigHostPath()
                if (capsHost) {
                    volumeArgs.push('-v', `${capsHost}:${CAPS_CONTAINER_PATH}:ro`)
                }
            }
        } else if (v.type === 'hubSignerDir') {
            // Operator signer for the on-chain DOGE publishers (PRICE v0 / ANCHOR).
            // The directory carries the operator's signer.js plus its own
            // node_modules and key file, so the whole directory is mounted
            // read-only; ConfigService sets HUB_SIGNER_MODULE to the matching
            // in-container path. No-op when unconfigured.
            if (process.env.XCHAIN_NODE_HUB_SIGNER_DIR && fs.existsSync(process.env.XCHAIN_NODE_HUB_SIGNER_DIR)) {
                volumeArgs.push('-v', `${process.env.XCHAIN_NODE_HUB_SIGNER_DIR}:/XChainHub/operator-signer:ro`)
            }
        }
    }

    for (const u of docker.ulimits || []) {
        ulimitArgs.push('--ulimit', u)
    }

    return { portArgs, volumeArgs, ulimitArgs, singleton: !!docker.singleton }
}

async function buildAndUp(module, coin, network, overwriteContainerId = null, onlyExecution = false, dockerCmdArgs = null) {
    if (!checkIfModuleExists(module)) {
        throw "module not found"
    }

    const environmentVariables = await getDefaultConfig(module, coin, network)
    const dir = getModuleDir(module)

    // Go-live pre-flight: warns pre-launch, refuses a mainnet write-surface
    // deploy with un-armed settings once XCHAIN_NODE_GO_LIVE=1 (A1 / ).
    const { assertGoLiveReady } = require('./GoLiveGate')
    assertGoLiveReady(module, coin, network, environmentVariables, dir)

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

    const containerPrefix = getDockerContainerImageName(module, coin, network)

    // Table-driven per-service run-args (SERVICE_REGISTRY in constants.js)
    // replaces the old per-service switch/case: a new service is one table
    // entry, not four hand-edited dispatch sites (H1 / ). Singleton
    // services (hub/explorer/sync) clear coin/network so the shared container
    // name and network resolve correctly below.
    const built = buildModuleDockerArgs(module, environmentVariables, coin, network)
    if (built.singleton) {
        coin = ""
        network = ""
    }
    const portArgs = built.portArgs
    const volumeArgs = built.volumeArgs
    const ulimitArgs = built.ulimitArgs

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
                    throw "Invalid port value in configuration: " + pair
                }
            }
        }
    }

    // Pre-flight host-port collision check (multi-stack hosts), run BEFORE the
    // docker build so a collision fails fast instead of only surfacing after
    // minutes of image build are wasted (#2594). Safe to run ahead of the
    // overwrite/teardown below: assertNoHostPortConflicts excludes selfName
    // (containerPrefix) from conflicts by container name regardless of whether
    // the old container has been removed yet.
    await assertNoHostPortConflicts(portArgs, containerPrefix)

    return new Promise((resolve, reject) => {
        // Pass every container env var as a bare `--env NAME` (value supplied in
        // the execFile `env` option below), NOT `--env NAME=value` in argv. The
        // config map carries per-install secrets (HUB_DB_PASS/DECODER_DB_PASS/
        // INDEXER_DB_PASS, NODE_PASSWORD, HUB_API_KEY/INDEXER_API_KEY, the per-coin
        // *_API_KEY, TELEMETRY_ADMIN_KEY). In argv those would land in
        // /proc/<docker-pid>/cmdline (world-readable, no hidepid) AND in a failed
        // `docker run` error.message (which upstream logging prints, and an operator
        // pastes into a bug report). Mirrors DatabaseService's MYSQL_ROOT_PASSWORD
        // treatment. The value reaches the container identically; only argv changes.
        const envArgs = []
        const dockerEnv = { ...process.env }
        for (const key in environmentVariables) {
            envArgs.push('--env', key)
            dockerEnv[key] = String(environmentVariables[key])
        }

        console.log("Building image of module " + module + (coin && network ? " in " + coin + " " + network : ""))
        execFile('docker', ['build', '.', '-t', containerPrefix], { cwd: dir }, async (error) => {
            if (error) {
                reject("Error creating Docker image: " + redactSecrets(error.message))
                return
            }

            try {
                if (overwriteContainerId) {
                    try {
                        await killContainer(overwriteContainerId)
                    } catch { /* container may not be running */ }
                    try {
                        await removeContainer(overwriteContainerId)
                    } catch { /* container may have been removed manually */ }
                }

                // Name-keyed cleanup immediately before `docker run --name`, making
                // (re)creation idempotent against a leftover carcass the registry
                // never recorded: an interrupted onlyExecution run (registry insert
                // skipped, ModuleService.js ~L416), or a container that exists but
                // whose registry insert failed. The overwriteContainerId removal
                // above is id-keyed and misses both cases (uuid:9533ee7a).
                try {
                    await forceRemoveContainerByName(containerPrefix)
                } catch { /* tolerant by design; see DockerService.forceRemoveContainerByName */ }

                // One-shot execution containers (e.g. the e2e-test runner) must NOT get a
                // restart policy: after their command exits, `unless-stopped` would restart
                // them, re-running the suite and leaving the container "restarting" so the
                // subsequent `docker rm` fails. Persistent service containers keep the policy.
                const restartArgs = onlyExecution ? [] : ['--restart', 'unless-stopped']
                // Healthchecks only apply to persistent service containers. One-shot
                // execution containers exit immediately after their command; a healthcheck
                // would fire during the exit window and falsely mark them unhealthy.
                const healthcheckArgs = onlyExecution ? [] : buildHealthcheckArgs(module, environmentVariables)
                // Cap json-file log growth on persistent containers so a
                // long-running node cannot fill the host disk. Sized so the
                // --tail 100 log reader still lands inside a single rotated
                // file. One-shot execution containers exit immediately and
                // need no cap.
                const logOptArgs = onlyExecution ? [] : ['--log-opt', 'max-size=10m', '--log-opt', 'max-file=3']
                const runArgs = [
                    'run', '-d', ...restartArgs, '--name', containerPrefix, '--hostname', containerPrefix,
                    ...logOptArgs,
                    ...volumeArgs,
                    ...ulimitArgs,
                    ...healthcheckArgs,
                    '--network', getDockerNetwork(coin, network),
                    ...envArgs,
                    ...portArgs,
                    '-t', containerPrefix,
                    ...(dockerCmdArgs ?? [])
                ]

                console.log("Creating container of module " + module + (coin && network ? " in " + coin + " " + network : ""))
                execFile('docker', runArgs, { cwd: dir, env: dockerEnv }, async (error2, stdout) => {
                    if (error2) {
                        // error2.message embeds the full argv; redact any secret-shaped
                        // token defensively even though values now live in the child env.
                        reject("Error creating the container: " + redactSecrets(error2.message))
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
// generic branch whose "already built?" check is keyed per coin/network, which
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
            // (or a force-reinstall): bypass the ping/status-row early returns
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
        // another network in the same install run; skip it (an explicit
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
                // Decoder/indexer freshness must also be sampled BEFORE buildAndUp;
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
                } else if (module === HUB_MODULE_NAME) {
                    // Rotate the hub DB account to match the (possibly just-changed) HUB_DB_PASS
                    // env the new container started with; without this an `update xchain-hub`
                    // leaves the live hub account on the old password and locks the hub out.
                    await setHubDatabaseParameters()
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
        } catch (err) {
            // Preserve the original error instead of masking every failure in
            // this multi-step block (kill/remove/statusChanged/registry delete)
            // as a fixed "kill" message. Notably a successful `docker rm` with a
            // failed registry-row delete leaves the container gone but the
            // `modules` row stale, and the misleading message points diagnosis
            // at the wrong step.
            throw err
        }
    } else {
        // No live container found for this module (already removed, or never
        // built). A stale row can still linger in the `modules` tracking table
        // For example, the container may have been `docker rm`'d out of band, which silently
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
    buildHealthcheckArgs,
    buildModuleDockerArgs,
    assertNoHostPortConflicts,
    installModule,
    uninstallModule
}
