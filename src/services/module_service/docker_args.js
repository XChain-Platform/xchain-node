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

let fs = require('fs')
let path = require('path')
let { XChainService, SERVICE_REGISTRY, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, DEPENDENCY_HEALTH_START_PERIOD } = require('../../config')
let { getUtxoTrackerVolumeName } = require('../config_service')
let { getPublishedHostPorts } = require('../docker_service')
let config = require('../../config');
let validatorService = require('../validator_service')
const { getLogger } = require('../../observability/logger');
let logger = getLogger();

function configureDependencies(dependencies) {
    ({
        fs, path, XChainService, SERVICE_REGISTRY, HUB_MODULE_NAME,
        EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, DEPENDENCY_HEALTH_START_PERIOD,
        getUtxoTrackerVolumeName, getPublishedHostPorts, config, validatorService,
        logger
    } = dependencies)
}

// Split a `-p` value on its last colon into [IP:]HOST:CONTAINER fields (ip is
// '' when absent); null for a non-string or colon-less value.
function parsePortSpec(pair) {
    if (typeof pair !== 'string') return null
    const colonIdx = pair.lastIndexOf(':')
    if (colonIdx === -1) return null
    const beforeContainer = pair.substring(0, colonIdx)
    const hostIdx = beforeContainer.lastIndexOf(':')
    return {
        ip: hostIdx === -1 ? '' : beforeContainer.substring(0, hostIdx),
        hostPort: beforeContainer.substring(hostIdx + 1),
        containerPort: pair.substring(colonIdx + 1)
    }
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
            const spec = parsePortSpec(portArgs[i + 1])
            if (spec && /^\d+$/.test(spec.hostPort)) requested.push(spec.hostPort)
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
//   probe     - 'http_get' uses wget GET on `path` (default /status); 'jsonrpc_ping'
//               uses wget POST with a JSON-RPC ping payload; absent means no
//               healthcheck added
//   path      - http_get only: route to probe. Defaults to /status. Set it for
//               services whose /status is expensive: sync's /status runs a
//               SELECT COUNT(*) census over every replicated table, which on a
//               heavy multi-chain host (LTC+DOGE) takes longer than the
//               5s timeout and marks a correctly-serving container UNHEALTHY.
//               Sync's /health is O(1) liveness (circuit-breaker +
//               poll-error state, no table scans) and still 503s when the
//               replicator is genuinely wedged, so the probe measures liveness
//               rather than a full table census. The decoder sets it for the
//               opposite reason: its /status is cheap but too NARROW to be a
//               liveness probe (process-alive + DB-reachable only), so a block
//               loop retrying one height forever kept answering 200 and autoheal,
//               which reads nothing but Health.Status, never fired. Its /live
//               route is /status plus the stall check.

//   interval  - how often Docker reruns the check (--health-interval)
//   timeout   - per-check timeout (--health-timeout)
//   retries   - consecutive failures before marking unhealthy (--health-retries)
//   startPeriod - grace period after container start before failures count
//                 (--health-start-period); set long enough for npm start + DB connect
//   autoheal  - opt-in flag consumed by AutohealService/`xchain-node autoheal`:
//               when true, a container that stays unhealthy past the grace window
//               gets `docker restart`ed. Default OFF. Only set it where a restart
//               plausibly clears the wedge (stalled event loop, dead DB pool).
//               NEVER set it on xchain-utxo-tracker: that service deliberately
//               enters a stable halted state (503 while halted) instead of
//               exiting, and a restart would just re-enter the same halt.
//
// Timing rationale:
//   interval=15s  - frequent enough to detect a stuck service quickly without hammering
//   timeout=5s    - generous but short of the interval; covers a slow DB query
//   retries=3     - three misses (~45s) before marking unhealthy; avoids flapping
//   startPeriod=  - NOT sized from the service's own boot time. A service whose
//                   probe judges a startup step must grant a window at least as
//                   long as that step, or the probe reports the startup itself as
//                   a failure, so every entry whose probe cannot pass until a HARD
//                   DEPENDENCY is up takes DEPENDENCY_HEALTH_START_PERIOD (60s,
//                   config/constants.js) rather than a number of its own: encoder
//                   (its default /status 503s until the utxo-tracker is reachable
//                   and synced), hub and explorer (their probes run SELECT 1 against
//                   MariaDB). Self-judging boots keep their own literal: decoder
//                   (/live), indexer, utxo-tracker and miner all take 60s for their
//                   own DB connect or wallet prep, and sync gets its own hub-wait
//                   window, see its line below.
const SERVICE_HEALTHCHECK = {
    [XChainService.XCHAIN_DECODER]:       { portKey: 'DECODER_API_PORT',       probe: 'http_get',     path: '/live', interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s', autoheal: true },
    // The encoder carries no `path`, so its probe is the default GET /status, and
    // that route 503s until the utxo-tracker is reachable AND synced
    // (xchain-encoder/src/api.js, getServeReadiness). Its window therefore has to
    // cover the TRACKER's startup, not the encoder's own fast boot: at the former
    // 30s a simultaneous cold start had the encoder's grace expiring while the
    // tracker was still inside the 60s window it declares one line below, and this
    // is the one autoheal: true service whose probe judges another container.
    [XChainService.XCHAIN_ENCODER]:       { portKey: 'ENCODER_API_PORT',       probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: DEPENDENCY_HEALTH_START_PERIOD, autoheal: true },
    [XChainService.XCHAIN_UTXO_TRACKER]:  { portKey: 'UTXO_TRACKER_API_PORT',  probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    [XChainService.XCHAIN_INDEXER]:       { portKey: 'INDEXER_API_PORT',        probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s', autoheal: true },
    // The miner's API is JSON-RPC only (no GET /status route); an http_get probe 500s
    // on every check and marks the container permanently unhealthy. It probes `health`
    // rather than `ping` because ping always answers 200 and carries wallet readiness
    // in its body only, so a miner stalled on credential drift or an unreachable coin
    // node stayed healthy here; startPeriod widened to cover wallet prep,
    // which the probe now judges instead of ignoring.
    [XChainService.XCHAIN_REGTEST_MINER]: { portKey: 'REGTEST_MINER_API_PORT',  probe: 'jsonrpc_health', interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    // The hub probes `health`, not `ping`: ping is a bare SELECT 1, while health 503s
    // on a tripped DB breaker, a stale oracle round, and consensus-input alerting. A
    // hub that had stopped producing usable consensus data read healthy through the
    // narrow probe. Deliberately no autoheal: oracle staleness is usually
    // upstream, where a restart flaps the container and disrupts in-flight rounds.
    // Both this and the explorer's probe race a SELECT 1 against MariaDB and 503
    // when it loses, so both windows cover the DB container's own 60s start period
    // rather than the 45s each was given from its own boot time.
    [HUB_MODULE_NAME]:                    { portKey: 'HUB_PORT',                probe: 'jsonrpc_health', interval: '15s', timeout: '5s', retries: 3, startPeriod: DEPENDENCY_HEALTH_START_PERIOD },
    [EXPLORER_MODULE_NAME]:               { portKey: 'EXPLORER_API_PORT_HTTP',  probe: 'jsonrpc_ping', interval: '15s', timeout: '5s', retries: 3, startPeriod: DEPENDENCY_HEALTH_START_PERIOD },
    // sync's startPeriod covers MAX_HUB_WAIT_MS (xchain-sync/src/config.js, default
    // 300000ms), not just process boot. /health answers 503 'starting' for the
    // whole hub wait instead of reporting healthy with zero pollers running, and at
    // 45s + 3x15s the container would flip UNHEALTHY at ~90s
    // on any stack whose hub takes longer to come up. Docker ends the start period
    // on the first passing check, so the wider window costs nothing once sync is up,
    // and a hub that never arrives is not silently tolerated either: _waitForHub
    // exits non-zero at MAX_HUB_WAIT_MS and the restart policy takes over. Widen
    // both together if MAX_HUB_WAIT_MS is raised.
    [SYNC_MODULE_NAME]:                   { portKey: 'SYNC_API_PORT',           probe: 'http_get',     path: '/health', interval: '15s', timeout: '5s', retries: 3, startPeriod: '300s' }
    // xchain-e2e-test: one-shot execution container, never gets --restart, healthcheck not applicable
    // coin nodes (node module): managed by NodeService / crypto_nodes; not built via buildAndUp,
    //   so buildHealthcheckArgs never runs for them. Their probe is BAKED INTO THE IMAGE instead
    //   (HEALTHCHECK in crypto_nodes/<coin>/Dockerfile, an RPC getblockchaininfo ping), which is
    //   why there is no entry here. Deliberately no autoheal either, mirroring the utxo-tracker
    //   line above: a wedged daemon usually means corrupt state a blind restart re-enters.
    // database (mariadb): managed by DatabaseService with its own health tooling
}

// Build the --health-* flags for a service container's docker run invocation.
// Returns an empty array when no healthcheck is configured for the module
// (or when the required port env-var is missing), so callers are always safe.
// Resolve the healthcheck grace window, allowing a per-service env override.
// A fresh install starts the container (with this window already counting down)
// and THEN restores its bootstrap archive -- installModule runs
// ensureBootstrapUtxoTracker / ensureBootstrapMariaDb AFTER buildAndUp -- which
// on a large chain takes many minutes, far past the default 60s startPeriod, so
// the container is marked cosmetically unhealthy mid-restore. An install
// holds the command lock, which already keeps `autoheal` from firing (no watchdog
// restart mid-restore), but operators expecting a long restore can widen the
// Docker grace window via XCHAIN_NODE_HEALTH_START_PERIOD_<SERVICE> (service
// upper-cased, non-alnum -> underscore), e.g.
// XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER=900s. Accepts a value with
// an ms/s/m/h unit, or bare seconds (900), which is normalized to '900s' before
// it reaches docker: --health-start-period is parsed by Go's time.ParseDuration,
// which rejects a unitless number ("missing unit in duration") and fails the
// whole `docker run`, so the documented bare-seconds form must never be passed
// through verbatim. Anything else is ignored and the descriptor default stands.
function resolveStartPeriod(module, fallback) {
    const key = 'XCHAIN_NODE_HEALTH_START_PERIOD_'
        + String(module).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    const raw = config.HEALTH_START_PERIOD_ENV[key]
    if (!raw) return fallback
    const value = raw.trim()
    if (/^\d+(ms|s|m|h)$/.test(value)) return value
    if (/^\d+$/.test(value)) return value + 's'
    // Malformed override: say so rather than silently standing on the default,
    // mirroring the loud-drift guard in buildHealthcheckArgs below.
    logger.info("WARNING: ignoring " + key + "=" + value
        + ": expected bare seconds (900) or a duration with an ms/s/m/h unit (900s)")
    return fallback
}

// LOG_LEVEL / LOG_FORMAT / METRICS_ENABLED / XCHAIN_LOG_PATCH are read by every
// service's observability shim, and nothing carries them from the deploy host
// into a container unless they are named here: they appear in no module config
// store, so the shim stands on its compiled defaults and an operator has no way
// to raise a single box to debug, switch it to NDJSON, or expose /metrics
// without editing code.
//
// Resolution is narrowest-first: a value already in the per-install module
// config store wins, so an operator who pinned LOG_LEVEL for one coin keeps it;
// otherwise the deploy host's own environment supplies it. When neither sets a
// name nothing is fabricated, keeping the container env as small as it is today
// and leaving the shim defaults (LOG_LEVEL=info, LOG_FORMAT=text,
// METRICS_ENABLED=false, XCHAIN_LOG_PATCH=1) in force. Values ride the same
// bare `--env NAME` path as every other key, so none of them reach argv.
const OBSERVABILITY_ENV_KEYS = ['LOG_LEVEL', 'LOG_FORMAT', 'METRICS_ENABLED', 'XCHAIN_LOG_PATCH']

function resolveObservabilityEnv(environmentVariables, hostEnv = config.OBSERVABILITY_ENV) {
    const overlay = {}
    for (const key of OBSERVABILITY_ENV_KEYS) {
        if (environmentVariables && key in environmentVariables) continue
        const raw = hostEnv[key]
        if (raw === undefined || raw === '') continue
        overlay[key] = String(raw)
    }
    return overlay
}

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
        logger.info("WARNING: no healthcheck for " + module + ": env " + hc.portKey + " is unset")
        return []
    }

    let cmd
    if (hc.probe === 'jsonrpc_ping' || hc.probe === 'jsonrpc_health') {
        // JSON-RPC POST; hub, explorer, and the regtest miner all speak this protocol.
        // `ping` is bare liveness (a SELECT 1, or "the port answers"); `health` is the
        // richer verdict that 503s on a service that is up but no longer making
        // progress, and wget -qO- exits non-zero on that 503 exactly as it does on a
        // dead port. Pick per descriptor: a service whose ping already carries the
        // real verdict (explorer) stays on ping.
        const method = hc.probe === 'jsonrpc_health' ? 'health' : 'ping'
        cmd = `wget -T ${parseInt(hc.timeout, 10)} -qO- --post-data='{"jsonrpc":"2.0","method":"${method}","id":1}' --header='Content-Type: application/json' http://localhost:${port}/ || exit 1`
    } else {
        // Default: plain HTTP GET on /status; descriptors override via `path`
        // where /status is too expensive to double as a liveness probe (sync).
        cmd = `wget -T ${parseInt(hc.timeout, 10)} -qO- http://localhost:${port}${hc.path || '/status'} || exit 1`
    }

    return [
        '--health-cmd',      cmd,
        '--health-interval', hc.interval,
        '--health-timeout',  hc.timeout,
        '--health-retries',  String(hc.retries),
        '--health-start-period', resolveStartPeriod(module, hc.startPeriod)
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
function appendDockerPorts(portArgs, docker, environmentVariables) {
    for (const p of docker.ports || []) {
        if (p.always || (p.host in environmentVariables && p.container in environmentVariables)) {
            portArgs.push('-p', `${environmentVariables[p.host]}:${environmentVariables[p.container]}`)
        }
    }
}

function appendDockerVolumes(volumeArgs, docker, environmentVariables, coin, network) {
    for (const v of docker.volumes || []) {
        if (v.hostKey) {
            volumeArgs.push('-v', `${environmentVariables[v.hostKey]}:${v.container}`)
        } else if (v.hostFn === 'utxoTrackerVolume') {
            // Volume name derivation lives in one place (ConfigService), consumed
            // here and by resetModules + BootstrapService, so a non-default
            // NODE_PREFIX can never drift between them.
            volumeArgs.push('-v', `${getUtxoTrackerVolumeName(coin, network)}:${v.container}`)
        } else if (v.type === 'hubCapabilityConfig') {
            // Validator mode: mount the capability config (read-only) so the
            // hub's HUB_CAPABILITY_CONFIG path resolves inside the container.
            // No-op for a standalone hub (no validator configured).
            //
            // The DIRECTORY holding capabilities.json is what gets mounted, not
            // the file. A single-file bind mount permanently breaks `docker cp`
            // against this container - Docker recreates each mount destination
            // as a directory during a copy, collides with the file and aborts
            // with "mkdirat validator/capabilities.json: file exists" for EVERY
            // path, not just the mounted one. ValidatorService keeps that
            // directory holding nothing but the capability config, so the
            // validator's signing.key never enters the container.
            if ('HUB_CAPABILITY_CONFIG' in environmentVariables) {
                const { getCapabilityConfigMountDir, CAPS_CONTAINER_DIR } = validatorService
                const capsHostDir = getCapabilityConfigMountDir()
                if (capsHostDir) {
                    volumeArgs.push('-v', `${capsHostDir}:${CAPS_CONTAINER_DIR}:ro`)
                }
            }
        } else if (v.type === 'hubSignerDir') {
            // Operator signer for the on-chain DOGE publishers (PRICE v0 / ANCHOR).
            // The directory carries the operator's signer.js plus its own
            // node_modules and key file, so the whole directory is mounted
            // read-only; ConfigService sets HUB_SIGNER_MODULE to the matching
            // in-container path. No-op when unconfigured.
            if (config.XCHAIN_NODE_HUB_SIGNER_DIR && fs.existsSync(config.XCHAIN_NODE_HUB_SIGNER_DIR)) {
                volumeArgs.push('-v', `${config.XCHAIN_NODE_HUB_SIGNER_DIR}:/XChainHub/operator-signer:ro`)
            } else {
                // The signer `validator init` wrote. Its signer.js requires the
                // SDK, resolved from a node_modules mounted beside it: this
                // package's own node_modules, so init never has to run npm and
                // the container sees exactly the SDK the CLI uses. The SDK mount
                // lands INSIDE the read-only signer mount, which docker can only
                // do when the mountpoint already exists on the host (otherwise
                // container creation fails outright); getSignerMountDir()
                // guarantees that directory before naming the mount.
                const { getSignerMountDir, SIGNER_CONTAINER_DIR } = validatorService
                const signerDir = getSignerMountDir()
                if (signerDir) {
                    const nodeModules = path.join(__dirname, '../../../node_modules')
                    volumeArgs.push('-v', `${signerDir}:${SIGNER_CONTAINER_DIR}:ro`)
                    volumeArgs.push('-v', `${nodeModules}:${SIGNER_CONTAINER_DIR}/node_modules:ro`)
                }
            }
        }
    }
}

function appendDockerUlimits(ulimitArgs, docker) {
    for (const u of docker.ulimits || []) {
        ulimitArgs.push('--ulimit', u)
    }
}

function buildModuleDockerArgs(module, environmentVariables, coin, network) {
    const portArgs = []
    const volumeArgs = []
    const ulimitArgs = []
    const docker = (SERVICE_REGISTRY[module] || {}).docker
    if (!docker) return { portArgs, volumeArgs, ulimitArgs, singleton: false }

    appendDockerPorts(portArgs, docker, environmentVariables)
    appendDockerVolumes(volumeArgs, docker, environmentVariables, coin, network)
    appendDockerUlimits(ulimitArgs, docker)
    return { portArgs, volumeArgs, ulimitArgs, singleton: !!docker.singleton }
}

module.exports = {
    configureDependencies,
    SERVICE_HEALTHCHECK,
    resolveStartPeriod,
    OBSERVABILITY_ENV_KEYS,
    resolveObservabilityEnv,
    buildHealthcheckArgs,
    buildModuleDockerArgs,
    parsePortSpec,
    assertNoHostPortConflicts
}
