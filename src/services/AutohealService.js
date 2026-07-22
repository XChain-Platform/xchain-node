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
 * (~/.xchain-node/autoheal-state.json) prevents restarting the same
 * container more than once per cooldown window, so a service whose
 * wedge a restart does NOT clear cannot be flapped indefinitely.
 *
 * Detection-to-restart latency is the timer interval plus the health
 * retry budget plus the grace window; this is deliberate, restarts
 * are a last resort, not a fast path.
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
// Never restart the same container more than once per cooldown window.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

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

function readState(stateFile) {
    // { restarts: { <containerId>: <epoch ms of last autoheal restart> } }
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        if (parsed && typeof parsed.restarts === 'object' && parsed.restarts !== null) {
            return parsed
        }
    } catch {
        // Missing or corrupt state file: start clean. Worst case a container
        // gets one extra restart after a state loss, which is acceptable.
    }
    return { restarts: {} }
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
    const stateFile  = getStateFilePath()
    const state      = readState(stateFile)

    const result = { candidates: [], restarted: [], failed: [], skipped: [] }

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

        const health = status && status.State && status.State.Health
        if (!health || health.Status !== 'unhealthy') continue

        const since = getUnhealthySinceMs(health)
        if (since === null) {
            result.skipped.push({ module, coin, network, containerId, reason: 'no failing probe log to time the episode' })
            continue
        }
        if (now - since < graceMs) {
            result.skipped.push({ module, coin, network, containerId, reason: 'inside grace window' })
            console.log(`autoheal: ${label} is unhealthy but inside the ${graceMs}ms grace window, not restarting yet`)
            continue
        }

        const lastRestart = state.restarts[containerId]
        if (typeof lastRestart === 'number' && now - lastRestart < cooldownMs) {
            result.skipped.push({ module, coin, network, containerId, reason: 'inside restart cooldown' })
            console.log(`autoheal: ${label} already restarted ${now - lastRestart}ms ago (cooldown ${cooldownMs}ms), a restart is not clearing this wedge; investigate`)
            continue
        }

        result.candidates.push({ module, coin, network, containerId })
        if (dryRun) {
            console.log(`autoheal: DRY RUN, would restart ${label} (unhealthy for ${now - since}ms)`)
            continue
        }

        try {
            await restartContainer(containerId)
            state.restarts[containerId] = now
            result.restarted.push({ module, coin, network, containerId })
            console.log(`autoheal: restarted ${label} (unhealthy for ${now - since}ms)`)
        } catch (err) {
            result.failed.push({ module, coin, network, containerId, reason: String(err) })
            console.log(`autoheal: FAILED to restart ${label}: ${err}`)
        }
    }

    if (!dryRun && result.restarted.length > 0) {
        // Drop state entries for containers no longer in the registry so the
        // file cannot grow without bound across reinstalls.
        const known = new Set(modules.map(m => m.container_id))
        for (const id of Object.keys(state.restarts)) {
            if (!known.has(id)) delete state.restarts[id]
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
    DEFAULT_GRACE_MS,
    DEFAULT_COOLDOWN_MS
}
