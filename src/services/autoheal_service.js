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
 * `xchain-node autoheal` is a one-shot cron or systemd timer pass. It walks
 * opted-in module containers and restarts the ones whose Docker status is unhealthy and
 * continuously unhealthy past a grace window. An on-disk state file
 * (~/.xchain-node/autoheal-state.json) throttles restarts of the same
 * container: the first retry waits the base cooldown, and each further
 * restart of a container that never recovers DOUBLES the wait, up to a
 * ceiling. So a wedge a restart does not clear costs one restart per
 * cooldown, then per 2x, 4x, 8x... rather than one per cooldown forever.
 * The counter is dropped only on evidence the container recovered, including
 * a retained passing probe beyond the restart probation window.
 * There is deliberately no attempt cap: backoff ends churn without leaving a recoverable service down forever.
 * The escalation path instead: once a container has been restarted twice
 * in one episode without recovering, every pass that sees it logs an
 * "investigate" line at warn (stderr) and the command exits 2, so a
 * systemd OnFailure= hook or cron mail can act on a wedge that has stopped
 * being transient. A failed restart logs at error and exits 1.
 *
 * Detection-to-restart latency is the timer interval plus the health
 * retry budget plus the grace window; this is deliberate, restarts
 * are a last resort, not a fast path. The grace window is timed from
 * an onset persisted in the state file, NOT from Docker's Health.Log:
 * that log keeps only 5 entries, so at the 15s probe interval it can
 * never evidence an episode older than ~60-75s and any grace window
 * past that would be permanently unreachable.
 ********************************************************************/

const { db } = require('../state')
const { getStatusFromContainer, stopContainer, startContainer, getContainerStopSettings } = require('./docker_service')
const { restartModuleContainer } = require('./stop_budget_service')
const { SERVICE_HEALTHCHECK } = require('./module_service')
const {
    DEFAULT_GRACE_MS,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_COOLDOWN_CEILING_MS,
    DEFAULT_RESTART_PROBATION_MS,
    getStateFilePath,
    parsePositiveIntEnv,
    restartBackoffMs,
    readState,
    writeState,
    getUnhealthySinceMs,
    getLastHealthyProbeMs,
    isRecoveryEstablished
} = require('./autoheal_service/restart_state.js')
const { getLogger } = require('../observability/logger');
const logger = getLogger();

function autohealTiming() {
    return {
        graceMs: parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_GRACE_MS', DEFAULT_GRACE_MS),
        cooldownMs: parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS', DEFAULT_COOLDOWN_MS),
        ceilingMs: parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_COOLDOWN_CEILING_MS', DEFAULT_COOLDOWN_CEILING_MS),
        probationMs: parsePositiveIntEnv('XCHAIN_NODE_AUTOHEAL_PROBATION_MS', DEFAULT_RESTART_PROBATION_MS)
    }
}

function autohealCandidate(row) {
    const { module, coin, network, container_id: containerId } = row
    const label = [module, coin, network].filter(Boolean).join('/')
    if (!containerId) return null

    const hc = SERVICE_HEALTHCHECK[module]
    if (!hc || hc.autoheal !== true) return null
    return { module, coin, network, containerId, label }
}

async function inspectCandidate(candidate, result) {
    const { module, coin, network, containerId } = candidate
    try {
        candidate.status = await getStatusFromContainer(containerId)
        return true
    } catch {
        // Container gone or Docker unreachable for this id; the registry
        // reconcile on the next precheck cleans it up. Not our job here.
        result.skipped.push({ module, coin, network, containerId, reason: 'inspect failed' })
        return false
    }
}

async function handleAutohealStopped(candidate, state, result, dryRun, resumeStopped, now) {
    const { module, coin, network, containerId, label, status } = candidate
    if (!state.stoppedByAutoheal[containerId]) return null
    if (status && status.State && status.State.Status === 'running') {
        delete state.stoppedByAutoheal[containerId]
        return { handled: false, changed: true }
    }
    result.candidates.push({ module, coin, network, containerId })
    if (!resumeStopped) {
        result.escalated.push({ module, coin, network, containerId, attempts: state.restartCount[containerId] || 0 })
        logger.warn(`autoheal: ${label} remains stopped after a failed restart; investigate or rerun with --resume-stopped`)
        return { handled: true, changed: false }
    }
    if (dryRun) {
        logger.info(`autoheal: DRY RUN, would retry starting ${label}`)
        return { handled: true, changed: false }
    }
    try {
        await startContainer(containerId)
        delete state.stoppedByAutoheal[containerId]
        state.restarts[containerId] = now
        state.restartCount[containerId] = (state.restartCount[containerId] || 0) + 1
        result.restarted.push({ module, coin, network, containerId })
        logger.info(`autoheal: started ${label} after an earlier restart left it stopped`)
        return { handled: true, changed: true }
    } catch (err) {
        result.failed.push({ module, coin, network, containerId, reason: String(err) })
        logger.error(`autoheal: FAILED to start ${label} after an earlier restart left it stopped: ${err}`)
        return { handled: true, changed: false }
    }
}

// Heal only what is running. Docker freezes State.Health.Status when a container stops (the probe goroutine
// runs only while the container is up), so a container that happened to
// be unhealthy when an operator stopped it keeps reporting `unhealthy`
// while State.Status is `exited` - and a restart (stop, then start) of a
// stopped container STARTS it, silently undoing the stop. Frozen health from a
// container that is no longer probing is not evidence of a wedge. This
// costs no healing either: autoheal exists for the ALIVE-but-stalled
// case (see the file header), because `--restart unless-stopped` already
// covers a service whose PID exits, and declines to fire exactly when
// the operator was the one who stopped it. Same guard the bootstrap gate
// applies at BootstrapHealthGate.evaluateContainerState.
function skipNonRunning(candidate, state, result) {
    const { module, coin, network, containerId, status } = candidate
    const runState = status && status.State && status.State.Status
    if (runState === 'running') return null

    result.skipped.push({ module, coin, network, containerId, reason: `not running (state: ${runState || 'unknown'})` })
    // Forget the onset: a container that comes back up gets a fresh grace
    // window instead of inheriting a clock that has been stopped all along.
    // The attempt count is deliberately NOT dropped here - it is cleared on
    // an observed RECOVERY (below), and a pass that catches a container
    // mid-restart must not reset the backoff a real wedge has earned.
    if (state.unhealthySince[containerId] === undefined) return false
    delete state.unhealthySince[containerId]
    return true
}

function skipNonUnhealthy(candidate, health, state) {
    const { containerId } = candidate
    if (health && health.Status === 'unhealthy') return null

    let changed = false
    // Episode over (or the healthcheck is gone): forget the onset so the
    // next wedge starts its own clock instead of inheriting an old one.
    if (state.unhealthySince[containerId] !== undefined) {
        delete state.unhealthySince[containerId]
        changed = true
    }
    // On THIS branch drop the attempt count only on an OBSERVED `healthy`,
    // never on a bare `!== unhealthy`, so a container
    // that DID recover starts its next episode at the base cooldown. Backing
    // off is a response to a wedge restarts are not clearing; a recovery is
    // the evidence they cleared it, and `!== 'unhealthy'` is not that
    // evidence: a restart puts the container into `starting` for the
    // descriptor's start period plus its retry budget (60s + 3x15s for the
    // decoder/indexer, and an operator can widen it to minutes via
    // XCHAIN_NODE_HEALTH_START_PERIOD_<SERVICE>), so a pass landing in that
    // window would wipe the counter the restart it had just issued earned.
    // A wedge no restart clears then stayed at the BASE cooldown forever,
    // which is the churn the doubling exists to end. Same principle the
    // not-running guard above states: mid-restart is not recovery. `starting`
    // is its health-probation form. A container with no healthcheck keeps its
    // count too, and inertly: it can never reach the restart path below.
    if (health && health.Status === 'healthy' && state.restartCount[containerId] !== undefined) {
        delete state.restartCount[containerId]
        changed = true
    }
    return changed
}

function seedEpisodeOnset(health, state, containerId, now, derived) {
    // Anchor the episode to the FIRST pass that saw it unhealthy. Re-deriving
    // from Health.Log every pass cannot work: the log holds 5 entries and the
    // probes are 15s apart, so the derived onset never gets further than
    // ~60-75s back and a 120s grace window is unreachable. Seed from the
    // derived value so a container already wedged when autoheal first runs
    // is credited the episode Docker can still see.
    // Two halves of one rule. Reset the onset when the retained probes
    // POSITIVELY show a pass after it: a recovery-then-relapse that falls
    // entirely between two passes is never observed by the `!== unhealthy`
    // branch above, so without this the new episode inherits the old one's
    // clock and gets restarted inside its own grace window. Preserve the
    // onset when the log merely ROTATED older evidence away, which is the
    // ordinary case: absence of a pass is not evidence of one.
    let since = state.unhealthySince[containerId]
    const lastHealthy = getLastHealthyProbeMs(health)
    let onsetReseeded = false
    if (typeof since !== 'number' || !Number.isFinite(since) ||
        (typeof lastHealthy === 'number' && lastHealthy > since)) {
        since = Math.min(now, derived)
        state.unhealthySince[containerId] = since
        onsetReseeded = true
    }
    return { since, lastHealthy, onsetReseeded }
}

function clearRecoveredRestartCount(state, containerId, episode, probationMs) {
    // The attempt count means "restarts since this container was last
    // healthy", so a reseeded onset and a surviving count are two halves of
    // one rule pulled apart: the `!== unhealthy` branch above never sees a
    // recovery that fell between two passes, and the NEW episode then
    // inherits the old one's doubled cooldown. At the 6h ceiling that
    // suppresses a fresh wedge for six hours after the probes proved the
    // last one cleared. Drop the count on the same evidence that reseeded
    // the onset, but only when the pass OUTLASTED the restart's probation:
    // inside that window a pass is the restart's own artifact, which is the
    // rule the observed-healthy branch and the not-running guard defend.
    // Absence of a pass still changes nothing, here as there.
    if (!episode.onsetReseeded || state.restartCount[containerId] === undefined ||
        !isRecoveryEstablished(episode.lastHealthy, state.restarts[containerId], probationMs)) return false
    delete state.restartCount[containerId]
    return true
}

function establishEpisode(candidate, health, state, now, probationMs, result) {
    const { module, coin, network, containerId } = candidate
    const derived = getUnhealthySinceMs(health)
    if (derived === null) {
        result.skipped.push({ module, coin, network, containerId, reason: 'no failing probe log to time the episode' })
        return null
    }

    const episode = seedEpisodeOnset(health, state, containerId, now, derived)
    const restartCountCleared = clearRecoveredRestartCount(state, containerId, episode, probationMs)
    return { since: episode.since, changed: episode.onsetReseeded || restartCountCleared }
}

async function restartEligibleCandidate(candidate, since, timing, state, result, dryRun, now, wallStart) {
    const { module, coin, network, containerId, label } = candidate
    if (now - since < timing.graceMs) {
        result.skipped.push({ module, coin, network, containerId, reason: 'inside grace window' })
        logger.info(`autoheal: ${label} is unhealthy but inside the ${timing.graceMs}ms grace window, not restarting yet`)
        return
    }

    // Each restart this container has already survived without recovering widens
    // its next wait, so a deterministic wedge (a bad block, a persistent host
    // fault) costs one restart per cooldown, then per 2x, 4x... to the ceiling,
    // instead of one per cooldown forever.
    const attempts = state.restartCount[containerId] || 0
    const effectiveCooldownMs = restartBackoffMs(attempts, timing.cooldownMs, timing.ceilingMs)
    // Two restarts that did not clear the wedge is where the backoff starts doubling, and where it stops being transient.
    const escalated = attempts >= 2
    // Escalate on the restart path too: a timer slower than the doubled cooldown never lands in the cooldown branch.
    if (escalated) result.escalated.push({ module, coin, network, containerId, attempts })
    const lastRestart = state.restarts[containerId]
    if (typeof lastRestart === 'number' && now - lastRestart < effectiveCooldownMs) {
        result.skipped.push({ module, coin, network, containerId, reason: 'inside restart cooldown' })
        const log = escalated ? logger.warn : logger.info
        log(`autoheal: ${label} already restarted ${now - lastRestart}ms ago (${attempts} restart(s) this episode, backed-off cooldown ${effectiveCooldownMs}ms), a restart is not clearing this wedge; investigate`)
        return
    }
    if (escalated) {
        logger.warn(`autoheal: ${label} is still unhealthy after ${attempts} restart(s) this episode, a restart is not clearing this wedge; investigate`)
    }

    result.candidates.push({ module, coin, network, containerId })
    if (dryRun) {
        logger.info(`autoheal: DRY RUN, would restart ${label} (unhealthy for ${now - since}ms)`)
        return
    }

    try {
        // With the stop budget `stop` uses, so the restart gives a block-bound drain its time
        await restartModuleContainer(stopContainer, startContainer, module, coin, network, containerId,
            undefined, getContainerStopSettings)
        // Stamp the moment the restart finished, not the pass start: the cooldown
        // and the recovery probation both run "after a restart", and a drain that
        // hits its kill budget (120s for a decoder) plus earlier restarts in the
        // same pass would otherwise shorten both windows. `now` may be injected,
        // so advance it by the real time the restart consumed.
        state.restarts[containerId] = now + Math.max(0, Date.now() - wallStart)
        state.restartCount[containerId] = attempts + 1
        result.restarted.push({ module, coin, network, containerId })
        logger.info(`autoheal: restarted ${label} (unhealthy for ${now - since}ms, restart #${attempts + 1} this episode)`)
    } catch (err) {
        if (err && err.containerStopped) state.stoppedByAutoheal[containerId] = true
        result.failed.push({ module, coin, network, containerId, reason: String(err) })
        logger.error(`autoheal: FAILED to restart ${label}: ${err}`)
        return Boolean(err && err.containerStopped)
    }
}

function persistState(stateFile, state, modules) {
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
    for (const id of Object.keys(state.stoppedByAutoheal)) {
        if (!known.has(id)) delete state.stoppedByAutoheal[id]
    }
    writeState(stateFile, state)
}

// One pass. A vanished container does not abort the sweep; failures and escalation reach the CLI.
async function runAutoheal({ dryRun = false, resumeStopped = false, now = Date.now() } = {}) {
    const wallStart = Date.now()
    const timing = autohealTiming()
    const stateFile = getStateFilePath()
    const state = readState(stateFile)
    const result = { candidates: [], restarted: [], failed: [], skipped: [], escalated: [] }
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
        const candidate = autohealCandidate(row)
        if (!candidate) continue
        if (!await inspectCandidate(candidate, result)) continue

        const startRetry = await handleAutohealStopped(candidate, state, result, dryRun, resumeStopped, now)
        if (startRetry) {
            if (startRetry.changed) onsetChanged = true
            if (startRetry.handled) continue
        }

        const stoppedStateChanged = skipNonRunning(candidate, state, result)
        if (stoppedStateChanged !== null) {
            if (stoppedStateChanged) onsetChanged = true
            continue
        }

        const health = candidate.status && candidate.status.State && candidate.status.State.Health
        const recoveredStateChanged = skipNonUnhealthy(candidate, health, state)
        if (recoveredStateChanged !== null) {
            if (recoveredStateChanged) onsetChanged = true
            continue
        }

        const episode = establishEpisode(candidate, health, state, now, timing.probationMs, result)
        if (!episode) continue
        if (episode.changed) onsetChanged = true
        if (await restartEligibleCandidate(candidate, episode.since, timing, state, result, dryRun, now, wallStart)) {
            onsetChanged = true
        }
    }

    if (!dryRun && (onsetChanged || result.restarted.length > 0)) persistState(stateFile, state, modules)
    if (result.candidates.length === 0) logger.info('autoheal: nothing to do')
    return result
}

// The CLI exit code for one pass: 1 when a restart failed, 2 when a wedge outlived two restarts, else 0.
function autohealExitCode(result) {
    if (result.failed.length > 0) return 1
    if (result.escalated && result.escalated.length > 0) return 2
    return 0
}

module.exports = {
    runAutoheal,
    autohealExitCode,
    getUnhealthySinceMs,
    getLastHealthyProbeMs,
    isRecoveryEstablished,
    restartBackoffMs,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_COOLDOWN_CEILING_MS,
    DEFAULT_RESTART_PROBATION_MS
}
