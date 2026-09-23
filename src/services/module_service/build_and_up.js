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

let { execFile } = require('child_process')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let fs = require('fs')
let path = require('path')
let { HUB_MODULE_NAME, LIBRARY_BUNDLES } = require('../../config')
let { db } = require('../../state')
let { getModuleDir, checkIfModuleExists, getDockerContainerImageName, getDockerNetwork, getDefaultConfig, validatePort } = require('../config_service')
let { stopContainerByName, removeContainer, forceRemoveContainerByName, checkBuildKitAvailable } = require('../docker_service')
let { stopModuleContainer, stopTimeoutArgs } = require('../stop_budget_service')
let { statusChanged } = require('../status_service')
let { setHubDatabaseParameters } = require('../database_service')
let { redactSecrets } = require('../../utils/helpers')
let config = require('../../config');
let goLiveGate = require('../go_live_gate')
let memoryLimitService = require('../memory_limit_service')
let hubConsensusEnvGuard = require('../hub_consensus_env_guard')
let rollcallWiring = require('../rollcall_wiring')
let { readCheckoutIdentityFromDisk } = require('./git_checkout')
let { cloneGit, resolveBundledLibRef } = require('./clone_and_refs')
let { assertNoHostPortConflicts, resolveObservabilityEnv, buildHealthcheckArgs, buildModuleDockerArgs } = require('./docker_args')
const { parsePortSpec } = require('./docker_args')
let { attachCrossChainNetworks, verifyContainerMemoryLimit, logDockerCreateWarnings } = require('./container_networks')
const { getLogger } = require('../../observability/logger');
let logger = getLogger();

function configureDependencies(dependencies) {
    ;({
        execFile, execFileAsync, fs, path, HUB_MODULE_NAME, LIBRARY_BUNDLES, db,
        getModuleDir, checkIfModuleExists, getDockerContainerImageName,
        getDockerNetwork, getDefaultConfig, validatePort, stopContainerByName,
        removeContainer, forceRemoveContainerByName, checkBuildKitAvailable,
        stopModuleContainer, stopTimeoutArgs, statusChanged, setHubDatabaseParameters,
        redactSecrets, config, goLiveGate, memoryLimitService,
        hubConsensusEnvGuard, rollcallWiring, readCheckoutIdentityFromDisk,
        cloneGit, resolveBundledLibRef, assertNoHostPortConflicts,
        resolveObservabilityEnv, buildHealthcheckArgs, buildModuleDockerArgs,
        attachCrossChainNetworks, verifyContainerMemoryLimit,
        logDockerCreateWarnings, logger
    } = dependencies)
}

/**
 * Build the module image and (re)create its container from the current config.
 *
 * `options.reuseImage` keeps the image that is already tagged for this container and
 * skips both the bundled-library re-clone and `docker build`. A container freezes its
 * env at `docker run`, so the ONLY way to correct a credential it carries is to
 * recreate it; without this flag that correction also drags in whatever GitHub HEAD
 * holds today, turning a credential repair into an unreviewed version bump.
 *
 * @param {string} module
 * @param {string|null} coin
 * @param {string|null} network
 * @param {string|null} [overwriteContainerId]
 * @param {boolean} [onlyExecution]
 * @param {string[]|null} [dockerCmdArgs]
 * @param {{reuseImage?: boolean}} [options]
 * @returns {Promise<string>} the new container id
 */
async function assertDeploymentReady(module, coin, network, environmentVariables, dir, onlyExecution) {
    // Go-live pre-flight: warns pre-launch, refuses a mainnet write-surface
    // deploy with un-armed settings once XCHAIN_NODE_GO_LIVE=1.
    const { assertGoLiveReady } = goLiveGate
    assertGoLiveReady(module, coin, network, environmentVariables, dir)

    // A BTC indexer or validator hub with no DOGE indexer read wedges at its
    // first roll-call epoch close on any network with a ROLLCALL activation,
    // days after the deploy, with every container reading healthy. Refuse here
    // while nothing has been torn down. One-shot execution containers never
    // close an epoch, so they are exempt.
    if (!onlyExecution) {
        const { assertDogeReadWired } = rollcallWiring
        assertDogeReadWired(module, coin, network, environmentVariables)
    }

    // Hub consensus-shaped settings (HUB_NETWORK, ORACLE_MIN_SUBMISSIONS,
    // ORACLE_ROUND_INTERVAL/SUBMISSION_WINDOW, XCHAIN_PRICE_INDEXER_DB_*, and
    // on regtest the four XCHAIN/BTC derivation overrides) are
    // passed through from the INVOKING SHELL with no warning when absent, so a
    // recreate/update run from a shell that lacks one quietly deploys a hub
    // with different consensus behavior than the one just torn down. Refuses
    // when a RUNNING hub would lose a value it already has; only warns (never
    // blocks) when there is no running hub to lose anything from.
    if (module === HUB_MODULE_NAME) {
        const { assertNoHubConsensusEnvDrift } = hubConsensusEnvGuard
        await assertNoHubConsensusEnvDrift(environmentVariables)
    }

}
// Stage any bundled library modules into this service's build context.
    // The service's Dockerfile COPYs them in and npm resolves the
    // "file:./<lib>" deps recursively at install.
    // Staging exists to feed `docker build`; with reuseImage there is no build, and
    // re-cloning would silently move the module's source off the version the image
    // (and therefore the running container) was made from.
async function stageBundledLibraries(module, dir, reuseImage) {
    const bundledLibs = reuseImage ? [] : (LIBRARY_BUNDLES[module] || [])
    for (const lib of bundledLibs) {
        // Always re-clone so bundled-library commits land on every `update`.
        // The previous "clone only if missing" check meant xchain-vm changes
        // got silently ignored on `update xchain-indexer` because the cached
        // modules/xchain-vm dir from a prior run was reused verbatim.
        // cloneGit(rewrite=true) removes any existing dir before cloning.
        //
        // The ref is RESOLVED, never null. Passing null here meant "clone the
        // remote's default branch", which made a bundled library the one part
        // of a pinned install that floated: `install v0.9.0 xchain-indexer`
        // pinned the indexer and then staged whatever xchain-vm's default
        // branch happened to hold, into the consensus-critical VM, inside the
        // image the indexer actually runs. The indexer repo gitignores the
        // staged copy, so no tag pinned it and nothing surfaced the drift.
        // That is a fork vector today and a sharper one once the default
        // branch becomes develop, which is why this lands BEFORE the flip
        // (release-management spec sections 8 and 11).
        const libRef = await resolveBundledLibRef(module, lib)
        logger.info(`Cloning bundled library ${lib} for ${module} at ${libRef.ref}`
            + (libRef.pinned ? ` (manifest-pinned ${libRef.commit.slice(0, 12)})` : ` (${libRef.reason})`))
        await cloneGit(lib, true, false, libRef.ref, libRef.commit)
        const libSrc  = getModuleDir(lib)
        const libDest = path.join(dir, lib)
        logger.info("Staging " + lib + " into " + module + " build context")
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
}
// Table-driven per-service run-args (SERVICE_REGISTRY in constants.js)
    // replaces the old per-service switch/case: a new service is one table
    // entry, not four hand-edited dispatch sites. Singleton
    // services (hub/explorer/sync) clear coin/network so the shared container
    // name and network resolve correctly below.
function resolveDockerOptions(module, environmentVariables, coin, network) {
    const built = buildModuleDockerArgs(module, environmentVariables, coin, network)
    if (built.singleton) {
        coin = ""
        network = ""
    }
    return { coin, network, portArgs: built.portArgs, volumeArgs: built.volumeArgs, ulimitArgs: built.ulimitArgs }
}
// Container memory limit. Derived for the utxo-tracker from the host and
    // how many trackers share it (MemoryLimitService); explicit for any module
    // through XCHAIN_NODE_MODULE_MEMORY_MB_<SERVICE>. One-shot execution
    // containers stay uncapped. The registry read is handed this file's own
    // `db`, so it counts from the same handle the rest of this file uses.
async function resolveMemoryOptions(module, coin, network, onlyExecution) {
    if (onlyExecution) return { memoryArgs: [], memoryLimitMb: null }
    const { memoryArgsFor, countInstalledTrackers } = memoryLimitService
    const trackerCount = await countInstalledTrackers(db, { coin, network })
    const memory = memoryArgsFor(module, { trackerCount, coin, network })
    if (memory.note) logger.info(memory.note)
    return {
        memoryArgs: memory.args,
        memoryLimitMb: memory.args.length > 0 ? memory.mb : null
    }
}
// Validate all port values, parsed with the conflict check's grammar; refuse a
// host-interface (IP-scoped) spec, which no configured module port may carry.
function validatePortArgs(portArgs) {
    for (let i = 0; i < portArgs.length; i++) {
        if (portArgs[i] !== '-p') continue
        const pair = portArgs[i + 1]
        if (typeof pair === 'string' && !pair.includes(':')) continue
        const spec = parsePortSpec(pair)
        if (!spec || spec.ip !== '' || !validatePort(spec.hostPort) || !validatePort(spec.containerPort)) {
            throw "Invalid port value in configuration: " + pair
        }
    }
}

// With no build to make it, the tag has to already exist. Say so here rather
// than letting `docker run` fall through to a registry pull for an image name
// that was only ever local, which fails with an unrelated auth/not-found error.
async function assertReusableImage(reuseImage, containerPrefix, module, coin, network) {
    if (!reuseImage) return
    try {
        await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Id}}', containerPrefix])
    } catch {
        throw new Error(
            "No local image tagged " + containerPrefix + " to reuse; run `update " + module +
            (coin && network ? " " + coin + " " + network : "") + "` to build one."
        )
    }
}

// Stamp the source commit onto the IMAGE, not just onto a log line that
// scrolls away. Neither of the two things an operator can read off a running
// container answers "which code is this": the image tag is a fixed name, and
// the module's package.json version is a release string that stays put across
// dozens of commits (xchain-indexer has reported 2.7.17 since 2026-07-17), so
// both said "correct" about a container running a 13-hour-old tree.
//
// A label is the right carrier: it is fixed at build time, inherited by every
// container created from the image, and left alone by a `recreate` (which
// reuses the image and must NOT re-stamp it with whatever the checkout holds
// today, or the stamp would drift into the same lie). Read it back with
//   docker inspect --format '{{index .Config.Labels "xchain.source.commit"}}' <container>
function resolveSourceMetadata(reuseImage, dir) {
    const sourceLabels = reuseImage ? { commit: null, ref: null } : readCheckoutIdentityFromDisk(dir)
    const buildLabelArgs = []
    if (sourceLabels.commit) buildLabelArgs.push('--label', 'xchain.source.commit=' + sourceLabels.commit)
    if (sourceLabels.ref) buildLabelArgs.push('--label', 'xchain.source.ref=' + sourceLabels.ref)
    return { sourceLabels, buildLabelArgs }
}

// Pass every container env var as a bare `--env NAME` (value supplied in
// the execFile `env` option below), NOT `--env NAME=value` in argv. The
// config map carries per-install secrets (HUB_DB_PASS/DECODER_DB_PASS/
// INDEXER_DB_PASS, NODE_PASSWORD, HUB_API_KEY/INDEXER_API_KEY, the per-coin
// *_API_KEY, TELEMETRY_ADMIN_KEY). In argv those would land in
// /proc/<docker-pid>/cmdline (world-readable, no hidepid) AND in a failed
// `docker run` error.message (which upstream logging prints, and an operator
// pastes into a bug report). Mirrors DatabaseService's MYSQL_ROOT_PASSWORD
// treatment. The value reaches the container identically; only argv changes.
// The observability names resolved above join the map here so they travel
// the same value-out-of-argv path.
function resolveContainerEnvironment(environmentVariables) {
    const envArgs = []
    const dockerEnv = config.childProcessEnv()
    const containerEnv = { ...environmentVariables, ...resolveObservabilityEnv(environmentVariables) }
    for (const key in containerEnv) {
        envArgs.push('--env', key)
        dockerEnv[key] = String(containerEnv[key])
    }
    return { envArgs, dockerEnv }
}

// Everything from here on is image-independent: tear down the old container
// and `docker run` the tag. reuseImage enters it directly; the normal path
// enters it from the build callback.
async function removeExistingContainer(context) {
    const { overwriteContainerId, module, coin, network, containerPrefix } = context
    if (overwriteContainerId) {
        // SIGTERM with the service's budget, never `docker kill`: the
        // decoder and tracker break their loops at a block boundary, and
        // a kill lands mid-transaction or mid-rollback on every update.
        // A container that is already gone resolves stopped:false and the
        // remove below is what tolerates that.
        await stopModuleContainer(stopContainerByName, module, coin, network, overwriteContainerId)
        try {
            await removeContainer(overwriteContainerId)
        } catch { /* container may have been removed manually */ }
    }

    // Name-keyed cleanup immediately before `docker run --name`, making
    // (re)creation idempotent against a leftover carcass the registry
    // never recorded: an interrupted onlyExecution run (registry insert
    // skipped, ModuleService.js ~L416), or a container that exists but
    // whose registry insert failed. The overwriteContainerId removal
    // above is id-keyed and misses both cases.
    try {
        await forceRemoveContainerByName(containerPrefix)
    } catch { /* tolerant by design; see DockerService.forceRemoveContainerByName */ }
}

// One-shot execution containers (e.g. the e2e-test runner) must NOT get a
// restart policy: after their command exits, `unless-stopped` would restart
// them, re-running the suite and leaving the container "restarting" so the
// subsequent `docker rm` fails. Persistent service containers keep the policy.
// The same budget the CLI stops with is stamped on the container so an
// operator's plain `docker stop` or `docker restart` honours it too.
// Healthchecks only apply to persistent service containers. One-shot
// execution containers exit immediately after their command; a healthcheck
// would fire during the exit window and falsely mark them unhealthy.
// Cap json-file log growth on persistent containers so a long-running node
// cannot fill the host disk, and keep at least 48 h of history readable.
// 50m x 4 = 200 MB, enough for 48 h at the measured peak with headroom.
function buildContainerRunArgs(context) {
    const { onlyExecution, module, environmentVariables, containerPrefix, volumeArgs,
        ulimitArgs, memoryArgs, coin, network, envArgs, portArgs, dockerCmdArgs } = context
    const restartArgs = onlyExecution ? [] : ['--restart', 'unless-stopped']
    const stopBudgetArgs = onlyExecution ? [] : stopTimeoutArgs(module)
    const healthcheckArgs = onlyExecution ? [] : buildHealthcheckArgs(module, environmentVariables)
    const logOptArgs = onlyExecution ? [] : ['--log-opt', 'max-size=50m', '--log-opt', 'max-file=4']
    return [
        'run', '-d', ...restartArgs, ...stopBudgetArgs, '--name', containerPrefix, '--hostname', containerPrefix,
        ...logOptArgs, ...volumeArgs, ...ulimitArgs, ...memoryArgs, ...healthcheckArgs,
        '--network', getDockerNetwork(coin, network), ...envArgs, ...portArgs,
        '-t', containerPrefix, ...(dockerCmdArgs ?? [])
    ]
}

// Cross-chain network membership is part of creating the container, not a
// post-install nicety: install, update and recreate all funnel through here.
// The hub's DB grant must exist before statusChanged pushes config over its API.
async function recordContainer(context, containerId) {
    const { onlyExecution, module, coin, network, memoryLimitMb } = context
    if (onlyExecution) return containerId
    await verifyContainerMemoryLimit(containerId, module, coin, network, memoryLimitMb)
    if (!await db.setModuleContainer(module, coin, network, containerId)) {
        throw "There was a problem trying to store the container's id"
    }
    await attachCrossChainNetworks(module, coin, network, containerId)
    if (module === HUB_MODULE_NAME) await setHubDatabaseParameters()
    await statusChanged()
    return containerId
}

async function handleContainerResult(context, error, stdout, stderr) {
    if (error) throw "Error creating the container: " + redactSecrets(error.message)
    logDockerCreateWarnings(stderr, context.module, context.coin, context.network)
    const containerId = stdout.trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
        throw "Invalid container ID returned by Docker: " + containerId
    }
    return recordContainer(context, containerId)
}

async function createContainer(context, resolve, reject) {
    try {
        await removeExistingContainer(context)
        const runArgs = buildContainerRunArgs(context)
        const { module, coin, network, dir, dockerEnv } = context
        logger.info("Creating container of module " + module + (coin && network ? " in " + coin + " " + network : ""))
        execFile('docker', runArgs, { cwd: dir, env: dockerEnv }, (error, stdout, stderr) => {
            handleContainerResult(context, error, stdout, stderr).then(resolve, reject)
        })
    } catch (err) {
        reject(err)
    }
}

// The module Dockerfiles only build under BuildKit. Refuse before the build
// and pin DOCKER_BUILDKIT=1 so a host override cannot select the legacy builder.
function buildOrCreateContainer(context, resolve, reject) {
    const { reuseImage, module, coin, network, sourceLabels, buildLabelArgs,
        containerPrefix, dir } = context
    if (reuseImage) {
        logger.info("Reusing the existing image of module " + module + (coin && network ? " in " + coin + " " + network : ""))
        createContainer(context, resolve, reject)
        return
    }
    const buildKitProbe = typeof checkBuildKitAvailable === 'function'
        ? checkBuildKitAvailable()
        : Promise.resolve(true)
    buildKitProbe.then(() => {
        logger.info("Building image of module " + module + (coin && network ? " in " + coin + " " + network : "")
            + (sourceLabels.commit ? " from " + sourceLabels.commit.slice(0, 12) + " (" + (sourceLabels.ref || 'detached') + ")" : ""))
        const buildEnv = { ...config.childProcessEnv(), DOCKER_BUILDKIT: '1' }
        execFile('docker', ['build', ...buildLabelArgs, '.', '-t', containerPrefix], { cwd: dir, env: buildEnv }, (error) => {
            if (error) {
                reject("Error creating Docker image: " + redactSecrets(error.message))
                return
            }
            createContainer(context, resolve, reject)
        })
    }).catch((err) => reject("Error creating Docker image: " + err))
}

function launchContainer(context) {
    return new Promise((resolve, reject) => buildOrCreateContainer(context, resolve, reject))
}
async function buildAndUp(module, coin, network, overwriteContainerId = null, onlyExecution = false, dockerCmdArgs = null, options = {}) {
    if (!checkIfModuleExists(module)) throw "module not found"
    const reuseImage = options.reuseImage === true
    const environmentVariables = await getDefaultConfig(module, coin, network)
    const dir = getModuleDir(module)
    await assertDeploymentReady(module, coin, network, environmentVariables, dir, onlyExecution)
    await stageBundledLibraries(module, dir, reuseImage)
    const containerPrefix = getDockerContainerImageName(module, coin, network)
    const dockerOptions = resolveDockerOptions(module, environmentVariables, coin, network)
    ;({ coin, network } = dockerOptions)
    const memoryOptions = await resolveMemoryOptions(module, coin, network, onlyExecution)
    validatePortArgs(dockerOptions.portArgs)
    await assertNoHostPortConflicts(dockerOptions.portArgs, containerPrefix)
    await assertReusableImage(reuseImage, containerPrefix, module, coin, network)
    const sourceMetadata = resolveSourceMetadata(reuseImage, dir)
    const containerEnvironment = resolveContainerEnvironment(environmentVariables)
    return launchContainer({
        module, coin, network, overwriteContainerId, onlyExecution, dockerCmdArgs,
        reuseImage, environmentVariables, dir, containerPrefix,
        ...dockerOptions, ...memoryOptions, ...sourceMetadata, ...containerEnvironment
    })
}

module.exports = { configureDependencies, buildAndUp, validatePortArgs }
