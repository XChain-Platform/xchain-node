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
 *
 * Stop budgets for service containers.
 *
 * The coin node has had a flush budget since v0.15.0 (NodeService). The
 * services had none: update, recreate and uninstall tore them down with
 * `docker kill`, and `stop` issued a bare `docker stop`, so SIGKILL arrived
 * either at once or at docker's ten second default and every drain a service
 * registers on SIGTERM was dead code on the CLI path. An operator's
 * `docker stop -t 180` on a BTC mainnet stack still returned decoder 137 and
 * tracker 1 (2026-09-10), which is what the per-service budgets below are
 * sized against: the decoder and tracker break their loops at a block
 * boundary and a mainnet block can take a while, the rest exit in seconds.
 *
 * The budget is stamped on the container as `--stop-timeout` too, so a plain
 * `docker stop` or `docker restart` by hand honours it without `-t`.
 *
 ********************************************************************/

const DEFAULT_MODULE_STOP_TIMEOUT_SECONDS = 30

// Services whose SIGTERM drain waits for a block boundary. Anything not listed
// gets the default.
const MODULE_STOP_TIMEOUT_SECONDS = Object.freeze({
    'xchain-decoder':      120,
    'xchain-utxo-tracker': 120
})

// XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER, and so on, the same
// derivation MemoryLimitService uses for its per-module override.
function moduleStopTimeoutEnvName(module) {
    return 'XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_' + String(module).toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

// The budget in seconds for one service. The coin node keeps its own resolver
// and variable (XCHAIN_NODE_STOP_TIMEOUT_SECONDS) because its budget is about
// a chainstate flush, not a drain; it is answered here so `stop node` and
// `stop all` read one function. A value that is not a whole number of seconds
// is ignored with a warning rather than silently becoming ten seconds.
function moduleStopTimeoutSeconds(module, env = process.env) {
    if (module === 'node') return require('./NodeService').nodeStopTimeoutSeconds()
    const key = moduleStopTimeoutEnvName(module)
    const raw = env[key]
    const fallback = MODULE_STOP_TIMEOUT_SECONDS[module] ?? DEFAULT_MODULE_STOP_TIMEOUT_SECONDS
    if (raw === undefined || String(raw).trim() === '') return fallback
    const seconds = parseInt(raw, 10)
    if (!Number.isFinite(seconds) || seconds < 1 || String(seconds) !== String(raw).trim()) {
        console.warn(`${key}=${raw} is not a whole number of seconds; using the default ${fallback}`)
        return fallback
    }
    return seconds
}

// `docker run` args that make the container's own stop honour the budget.
function stopTimeoutArgs(module, env = process.env) {
    return ['--stop-timeout', String(moduleStopTimeoutSeconds(module, env))]
}

// What the operator reads after a service was stopped. A stop that ran out of
// budget is a kill, and a killed decoder may have been mid-rollback; that is
// worth a warning line, not silence. Returns null when there was nothing to
// stop (already gone), because the caller's remove or run surfaces that.
function describeModuleStopOutcome(module, coin, network, outcome, budgetSeconds) {
    if (!outcome || !outcome.stopped) return null
    const where = coin && network ? ` (${coin} ${network})` : ''
    if (outcome.killed) {
        return `WARNING: ${module}${where} did not exit within the ${budgetSeconds} s budget and was killed. ` +
            `Raise ${moduleStopTimeoutEnvName(module)} if this service needs longer to finish its block.`
    }
    return `Stopped ${module}${where} cleanly in ${outcome.seconds} s (budget ${budgetSeconds} s).`
}

// One stop for every CLI path that takes a service container down: stop with
// the budget, say what happened, return the outcome so the caller can decide
// whether a kill matters to it. `stopContainerByName` accepts an id as well
// as a name (docker echoes back whatever it was given).
async function stopModuleContainer(stopContainerByName, module, coin, network, containerRef, env = process.env) {
    const budget = moduleStopTimeoutSeconds(module, env)
    const outcome = await stopContainerByName(containerRef, budget)
    const line = describeModuleStopOutcome(module, coin, network, outcome, budget)
    if (line) {
        if (outcome.killed) console.warn(line)
        else console.log(line)
    }
    return { ...outcome, budget }
}

module.exports = {
    DEFAULT_MODULE_STOP_TIMEOUT_SECONDS,
    MODULE_STOP_TIMEOUT_SECONDS,
    moduleStopTimeoutEnvName,
    moduleStopTimeoutSeconds,
    stopTimeoutArgs,
    describeModuleStopOutcome,
    stopModuleContainer
}
