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
 * XChain Node - Autoheal restart state
 ********************************************************************/

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const config = require('../../config');

// A container must be continuously unhealthy for at least this long before
// a restart is considered (on top of Docker's own retries budget).
const DEFAULT_GRACE_MS = 2 * 60 * 1000
// Wait at least this long after a restart before restarting the same container
// again. This is the FIRST retry's wait; see restartBackoffMs for the doubling.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000
// Upper bound on the doubled cooldown, so a long-wedged container settles at one
// restart every six hours rather than growing to a wait no operator would outlive.
const DEFAULT_COOLDOWN_CEILING_MS = 6 * 60 * 60 * 1000
// A passing probe landing inside this window after an autoheal restart is that
// restart's own artifact, not evidence the wedge cleared. Every service opted
// into autoheal in SERVICE_HEALTHCHECK (decoder, encoder, indexer) probes at a
// 15s interval with 3 retries behind a 60s start period, so Docker can
// legitimately report `starting` or a first fresh pass for ~105s after a
// restart; 150s leaves margin. An operator who widens a service's start period
// via XCHAIN_NODE_HEALTH_START_PERIOD_<SERVICE> should widen
// XCHAIN_NODE_AUTOHEAL_PROBATION_MS to match.
const DEFAULT_RESTART_PROBATION_MS = 150 * 1000

const STATE_DIR_NAME  = '.xchain-node'
const STATE_FILE_NAME = 'autoheal-state.json'

function getStateFilePath() {
    // XCHAIN_NODE_AUTOHEAL_STATE_DIR is a test/ops override; the default
    // matches the per-user dir used by credentials.json and command.lock.
    const dir = config.XCHAIN_NODE_AUTOHEAL_STATE_DIR ||
                config.XCHAIN_NODE_LOCK_DIR ||
                path.join(os.homedir(), STATE_DIR_NAME)
    return path.join(dir, STATE_FILE_NAME)
}

function parsePositiveIntEnv(name, fallback) {
    const raw = config.AUTOHEAL_TIMING_ENV[name]
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

// When the newest PASSING probe in Health.Log ran, or null when the retained
// entries hold no pass. Reads Start (the same clock getUnhealthySinceMs seeds
// the onset from) so the two values compare like for like, falling back to End
// only when Start is unparseable. Never throws on a missing or garbage log.
//
// This is the only positive evidence of a RECOVERY the retained log can carry.
// Its absence means nothing either way: five entries at a 15s probe interval
// span ~60-75s, so an older pass has simply rotated out. runAutoheal treats it
// that way, resetting the episode only on a pass it can actually see.
function getLastHealthyProbeMs(health) {
    const log = Array.isArray(health && health.Log) ? health.Log : []
    for (let i = log.length - 1; i >= 0; i--) {
        const entry = log[i]
        if (!entry || entry.ExitCode !== 0) continue
        const at = Date.parse(entry.Start)
        if (!Number.isNaN(at)) return at
        const end = Date.parse(entry.End)
        if (!Number.isNaN(end)) return end
        return null
    }
    return null
}

// Whether a retained passing probe is evidence of a RECOVERY rather than an
// artifact of the restart autoheal itself issued. A pass qualifies when there
// is no autoheal restart to attribute it to, or when it landed more than the
// probation window after that restart. Pure, so both sides of the rule are
// unit-testable without driving a whole pass.
function isRecoveryEstablished(lastHealthyMs, lastRestartMs, probationMs) {
    if (!Number.isFinite(lastHealthyMs)) return false
    if (!Number.isFinite(lastRestartMs)) return true
    return lastHealthyMs > lastRestartMs + probationMs
}

module.exports = {
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
}
