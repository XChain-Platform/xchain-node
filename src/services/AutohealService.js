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
 * XChain Node - Autoheal
 *
 * Closes the loop on container healthchecks. buildHealthcheckArgs
 * attaches --health-* probes to every persistent service, and the
 * probes correctly report wedges (e.g. the indexer's /status returns
 * 503 while stalled), but plain `docker run` takes no action on the
 * `unhealthy` state: --restart unless-stopped only fires when the PID
 * exits. An alive-but-stalled service therefore stays wedged forever,
 * visible only in `docker ps`.
 *
 * `xchain-node autoheal` is a ONE-SHOT pass meant to run from cron or
 * a systemd timer (it never prompts and never daemonizes): it walks
 * the module registry, inspects each container whose service opted in
 * via `autoheal: true` in SERVICE_HEALTHCHECK, and restarts the ones
 * whose Docker health status is `unhealthy` AND which have been
 * continuously unhealthy past a grace window. An on-disk state file
 * (~/.xchain-node/autoheal-state.json) throttles restarts of the same
 * container: the first retry waits the base cooldown, and each further
 * restart of a container that never recovers DOUBLES the wait, up to a
 * ceiling. So a wedge a restart does not clear costs one restart per
 * cooldown, then per 2x, 4x, 8x... rather than one per cooldown forever.
 * The counter resets the moment the container reports healthy, so a
 * transient wedge always starts again from the base cooldown.
 *
 * Deliberately no attempt CAP and no terminal suppression: this is a
 * watchdog on node containers, and a cap that stops retrying can leave a
 * RECOVERABLE service down through an outage that would have self-cleared.
 * Backing off ends the churn; giving up would trade it for an outage.
 * Every skipped pass still logs an "investigate" line, which is the
 * escalation path for a wedge that has stopped being transient.
 *
 * Detection-to-restart latency is the timer interval plus the health
 * retry budget plus the grace window; this is deliberate, restarts
 * are a last resort, not a fast path. The grace window is timed from
 * an onset persisted in the state file, NOT from Docker's Health.Log:
 * that log keeps only 5 entries, so at the 15s probe interval it can
 * never evidence an episode older than ~60-75s and any grace window
 * past that would be permanently unreachable.
 ********************************************************************/

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const { db } = require('../state')
const { getStatusFromContainer, restartContainer } = require('./DockerService')
const { SERVICE_HEALTHCHECK } = require('./ModuleService')

// A container must be continuously unhealthy for at least this long before
// a restart is considered (on top of Docker's own retries budget).
const DEFAULT_GRACE_MS = 2 * 60 * 1000
// Wait at least this long after a restart before restarting the same container
// again. This is the FIRST retry's wait; see restartBackoffMs for the doubling.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000
// Upper bound on the doubled cooldown, so a long-wedged container settles at one
// restart every six hours rather than growing to a wait no operator would outlive.
const DEFAULT_COOLDOWN_CEILING_MS = 6 * 60 * 60 * 1000

const STATE_DIR_NAME  = '.xchain-node'
const STATE_FILE_NAME = 'autoheal-state.json'

function getStateFilePath() {
    // XCHAIN_NODE_AUTOHEAL_STATE_DIR is a test/ops override; the default
    // matches the per-user dir used by credentials.json and command.lock.
    const dir = process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR ||
                process.env.XCHAIN_NODE_LOCK_DIR ||
                path.join(os.homedir(), STATE_DIR_NAME)
    return path.join(dir, STATE_FILE_NAME)
}

function parsePositiveIntEnv(name, fallback) {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return fallback
    return n
}

// How long to wait before the Nth restart of a container that has not recovered.
// attempts is the number of restarts already performed in this unhealthy run, so
// attempts<=1 yields the plain base cooldown and the first retry keeps its
// documented timing; every further one doubles. A very large attempts count sends
// the product to Infinity, which Math.min resolves to the ceiling, not to NaN.
function restartBackoffMs(attempts, cooldownMs, ceilingMs) {
    if (!(attempts > 1)) return cooldownMs
    return Math.min(cooldownMs * Math.pow(2, attempts - 1), ceilingMs)
}

function readState(stateFile) {
    // {
    //   restarts:       { <containerId>: <epoch ms of last autoheal restart> },
    //   unhealthySince: { <containerId>: <epoch ms this unhealthy episode began> },
    //   restartCount:   { <containerId>: <restarts since this container last was healthy> }
    // }
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        if (parsed && typeof parsed.restarts === 'object' && parsed.restarts !== null) {
            // unhealthySince arrived after restarts; an older state file has none.
            if (typeof parsed.unhealthySince !== 'object' || parsed.unhealthySince === null) {
                parsed.unhealthySince = {}
            }
            // restartCount arrived after both. An older file reads as zero attempts,
            // which costs a wedge one un-backed-off retry after an upgrade, never a
            // missed restart.
            if (typeof parsed.restartCount !== 'object' || parsed.restartCount === null) {
                parsed.restartCount = {}
            }
            return parsed
        }
    } catch {
        // Missing or corrupt state file: start clean. Worst case a container
        // gets one extra restart after a state loss, which is acceptable.
    }
    return { restarts: {}, unhealthySince: {}, restartCount: {} }
}

function writeState(stateFile, state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
}

// How long the container has been CONTINUOUSLY unhealthy, derived from the
// trailing run of failing probe entries in Health.Log (each entry carries
// Start/End/ExitCode). Returns null when it cannot be established (no log,
// or the newest entry passed), in which case the caller must NOT restart:
// without evidence of a sustained wedge a restart is just noise.
//
// This is a LOWER BOUND on the episode, never its true start: Docker retains
// only the last 5 Health.Log entries, so at the 15s probe interval every
// descriptor uses, the oldest entry is at most ~60-75s old and the value
// returned here slides forward with each new probe. Use it only to seed the
// persisted onset in runAutoheal; timing the grace window off it directly
// caps the measurable episode below any grace window over ~75s.
function getUnhealthySinceMs(health) {
    const log = Array.isArray(health.Log) ? health.Log : []
    if (log.length === 0) return null

    // Entries are ordered oldest -> newest; walk back through the trailing
    // consecutive failures to find when this unhealthy episode began.
    let since = null
    for (let i = log.length - 1; i >= 0; i--) {
        const entry = log[i]
        if (!entry || entry.ExitCode === 0) break
        const start = Date.parse(entry.Start)
        if (Number.isNaN(start)) break
        since = start
    }
    return since
}

// One autoheal pass over the module registry. Never throws for a single bad
// container (a vanished container id must not abort the whole sweep).
// Returns { candidates, restarted, failed, skipped } where each array holds
// { module, coin, network, containerId, reason? }.
async function runAutoheal({ dryRun = false, now = Date.now() } = {}) {
    const graceMs    = parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_GRACE_MS', DEFAULT_GRACE_MS)
    const cooldownMs = parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS', DEFAULT_COOLDOWN_MS)
    const ceilingMs  = parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_COOLDOWN_CEILING_MS', DEFAULT_COOLDOWN_CEILING_MS)
    const stateFile  = getStateFilePath()
    const state      = readState(stateFile)

    const result = { candidates: [], restarted: [], failed: [], skipped: [] }
    // Set whenever an episode-onset or attempt-count entry is recorded or cleared,
    // so the pass persists it even when nothing was restarted. Without this the
    // onset never survives to the next pass and the grace window can never be
    // crossed, and a recovery never clears the backoff it earned.
    let onsetChanged = false

    // An unconfigured store yields zero rows, which autoheal would report as a
    // clean "nothing to heal" run while every unhealthy container stays down.
    // A watchdog that cannot read its own registry must say so.
    db.assertReady("autoheal")

    const modules = await db.getAllModuleContainers(null, null)
    for (const row of modules) {
        const { module, coin, network, container_id: containerId } = row
        const label = [module, coin, network].filter(Boolean).join('/')
        if (!containerId) continue

        const hc = SERVICE_HEALTHCHECK[module]
        if (!hc || hc.autoheal !== true) continue

        let status
        try {
            status = await getStatusFromContainer(containerId)
        } catch {
            // Container gone or Docker unreachable for this id; the registry
            // reconcile on the next precheck cleans it up. Not our job here.
            result.skipped.push({ module, coin, network, containerId, reason: 'inspect failed' })
            continue
        }

        // Heal only what is actually RUNNING. Docker freezes State.Health.Status
        // at its last value the moment a container stops (the probe goroutine
        // runs only while the container is up), so a container that happened to
        // be unhealthy when an operator stopped it keeps reporting `unhealthy`
        // while State.Status is `exited` - and `docker restart` on a stopped
        // container STARTS it, silently undoing the stop. Frozen health from a
        // container that is no longer probing is not evidence of a wedge. This
        // costs no healing either: autoheal exists for the ALIVE-but-stalled
        // case (see the file header), because `--restart unless-stopped` already
        // covers a service whose PID exits, and declines to fire exactly when
        // the operator was the one who stopped it. Same guard the bootstrap gate
        // applies at BootstrapHealthGate.evaluateContainerState.
        const runState = status && status.State && status.State.Status
        if (runState !== 'running') {
            result.skipped.push({ module, coin, network, containerId, reason: `not running (state: ${runState || 'unknown'})` })
            // Forget the onset: a container that comes back up gets a fresh grace
            // window instead of inheriting a clock that has been stopped all along.
            // The attempt count is deliberately NOT dropped here - it is cleared on
            // an observed RECOVERY (below), and a pass that catches a container
            // mid-restart must not reset the backoff a real wedge has earned.
            if (state.unhealthySince[containerId] !== undefined) {
                delete state.unhealthySince[containerId]
                onsetChanged = true
            }
            continue
        }

        const health = status && status.State && status.State.Health
        if (!health || health.Status !== 'unhealthy') {
            // Episode over (or the healthcheck is gone): forget the onset so the
            // next wedge starts its own clock instead of inheriting an old one.
            if (state.unhealthySince[containerId] !== undefined) {
                delete state.unhealthySince[containerId]
                onsetChanged = true
            }
            // Drop the attempt count too, so a container that DID recover starts its
            // next episode at the base cooldown. Backing off is a response to a wedge
            // restarts are not clearing; a recovery is the evidence they cleared it.
            if (state.restartCount[containerId] !== undefined) {
                delete state.restartCount[containerId]
                onsetChanged = true
            }
            continue
        }

        const derived = getUnhealthySinceMs(health)
        if (derived === null) {
            result.skipped.push({ module, coin, network, containerId, reason: 'no failing probe log to time the episode' })
            continue
        }

        // Anchor the episode to the FIRST pass that saw it unhealthy. Re-deriving
        // from Health.Log every pass cannot work: the log holds 5 entries and the
        // probes are 15s apart, so the derived onset never gets further than
        // ~60-75s back and a 120s grace window is unreachable. Seed
        // from the derived value so a container already wedged when autoheal first
        // runs is credited the episode Docker can still see.
        let since = state.unhealthySince[containerId]
        if (typeof since !== 'number' || !Number.isFinite(since)) {
            since = Math.min(now, derived)
            state.unhealthySince[containerId] = since
            onsetChanged = true
        }

        if (now - since < graceMs) {
            result.skipped.push({ module, coin, network, containerId, reason: 'inside grace window' })
            console.log(`autoheal: ${label} is unhealthy but inside the ${graceMs}ms grace window, not restarting yet`)
            continue
        }

        // Each restart this container has already survived without recovering widens
        // its next wait, so a deterministic wedge (a bad block, a persistent host
        // fault) costs one restart per cooldown, then per 2x, 4x... to the ceiling,
        // instead of one per cooldown forever.
        const attempts        = state.restartCount[containerId] || 0
        const effectiveCooldownMs = restartBackoffMs(attempts, cooldownMs, ceilingMs)
        const lastRestart     = state.restarts[containerId]
        if (typeof lastRestart === 'number' && now - lastRestart < effectiveCooldownMs) {
            result.skipped.push({ module, coin, network, containerId, reason: 'inside restart cooldown' })
            console.log(`autoheal: ${label} already restarted ${now - lastRestart}ms ago (${attempts} restart(s) this episode, backed-off cooldown ${effectiveCooldownMs}ms), a restart is not clearing this wedge; investigate`)
            continue
        }

        result.candidates.push({ module, coin, network, containerId })
        if (dryRun) {
            console.log(`autoheal: DRY RUN, would restart ${label} (unhealthy for ${now - since}ms)`)
            continue
        }

        try {
            await restartContainer(containerId)
            state.restarts[containerId]     = now
            state.restartCount[containerId] = attempts + 1
            result.restarted.push({ module, coin, network, containerId })
            console.log(`autoheal: restarted ${label} (unhealthy for ${now - since}ms, restart #${attempts + 1} this episode)`)
        } catch (err) {
            result.failed.push({ module, coin, network, containerId, reason: String(err) })
            console.log(`autoheal: FAILED to restart ${label}: ${err}`)
        }
    }

    if (!dryRun && (onsetChanged || result.restarted.length > 0)) {
        // Drop state entries for containers no longer in the registry so the
        // file cannot grow without bound across reinstalls.
        const known = new Set(modules.map(m => m.container_id))
        for (const id of Object.keys(state.restarts)) {
            if (!known.has(id)) delete state.restarts[id]
        }
        for (const id of Object.keys(state.unhealthySince)) {
            if (!known.has(id)) delete state.unhealthySince[id]
        }
        for (const id of Object.keys(state.restartCount)) {
            if (!known.has(id)) delete state.restartCount[id]
        }
        writeState(stateFile, state)
    }

    if (result.candidates.length === 0) {
        console.log('autoheal: nothing to do')
    }
    return result
}

module.exports = {
    runAutoheal,
    getUnhealthySinceMs,
    getStateFilePath,
    restartBackoffMs,
    DEFAULT_GRACE_MS,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_COOLDOWN_CEILING_MS
}
