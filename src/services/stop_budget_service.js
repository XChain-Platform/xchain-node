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

const { MODULE_STOP_TIMEOUT_ENV } = require('../config')
const { getLogger } = require('../observability/logger');
const logger = getLogger();
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
function moduleStopTimeoutSeconds(module, env = MODULE_STOP_TIMEOUT_ENV) {
    if (module === 'node') return require('./node_service').nodeStopTimeoutSeconds()
    const key = moduleStopTimeoutEnvName(module)
    const raw = env[key]
    const fallback = MODULE_STOP_TIMEOUT_SECONDS[module] ?? DEFAULT_MODULE_STOP_TIMEOUT_SECONDS
    if (raw === undefined || String(raw).trim() === '') return fallback
    const seconds = parseInt(raw, 10)
    if (!Number.isFinite(seconds) || seconds < 1 || String(seconds) !== String(raw).trim()) {
        logger.warn(`${key}=${raw} is not a whole number of seconds; using the default ${fallback}`)
        return fallback
    }
    return seconds
}

// `docker run` args that make the container's own stop honour the budget.
function stopTimeoutArgs(module, env = MODULE_STOP_TIMEOUT_ENV) {
    return ['--stop-timeout', String(moduleStopTimeoutSeconds(module, env))]
}

// Gap between a service's own hard-exit timer and docker's SIGKILL, so a drain
// that runs out of time still exits itself and logs why before the kill.
const STOP_DRAIN_MARGIN_MS = 20000

function isDefaultStopBudget(module, seconds) {
    const fallback = MODULE_STOP_TIMEOUT_SECONDS[module] ?? DEFAULT_MODULE_STOP_TIMEOUT_SECONDS
    return seconds === fallback
}

// SHUTDOWN_TIMEOUT_MS the node hands a service, derived from its stop budget
// so the service's own hard exit always lands inside it: 120 s gives 100000,
// the decoder's and tracker's own default. Below 40 s the drain gets half the
// budget instead, since the margin would leave it nothing. Null for the coin
// node and for a service on the plain default budget, which keeps its own.
function moduleShutdownTimeoutMs(module, env = MODULE_STOP_TIMEOUT_ENV) {
    if (module === 'node') return null
    return shutdownTimeoutMsForBudget(module, moduleStopTimeoutSeconds(module, env))
}

function shutdownTimeoutMsForBudget(module, seconds) {
    if (module === 'node') return null
    const listed = Object.prototype.hasOwnProperty.call(MODULE_STOP_TIMEOUT_SECONDS, module)
    if (!listed && isDefaultStopBudget(module, seconds)) return null
    const budgetMs = seconds * 1000
    return Math.max(budgetMs - STOP_DRAIN_MARGIN_MS, Math.floor(budgetMs / 2))
}

// The container env entry that carries the derived drain budget. An explicit
// SHUTDOWN_TIMEOUT_MS in the module config wins and nothing is added, and so
// does a null module (a one-shot run has no stop budget to derive from).
function shutdownTimeoutEnv(module, moduleConfig, env = MODULE_STOP_TIMEOUT_ENV) {
    if (!module) return {}
    const configured = moduleConfig ? moduleConfig.SHUTDOWN_TIMEOUT_MS : undefined
    if (configured !== undefined && configured !== null && String(configured).trim() !== '') return {}
    const derived = moduleShutdownTimeoutMs(module, env)
    return derived === null ? {} : { SHUTDOWN_TIMEOUT_MS: String(derived) }
}

// Why a running service's own drain may not follow its current budget: the
// container carries a different stamped budget, or it predates the forwarded
// SHUTDOWN_TIMEOUT_MS while an override is set. Null when nothing drifted, the
// container could not be read, or neither side involves a forwarded drain.
function describeStopBudgetDrift(module, coin, network, settings, budgetSeconds) {
    if (!settings || module === 'node') return null
    const forwards = shutdownTimeoutMsForBudget(module, budgetSeconds) !== null
    if (!forwards && settings.shutdownTimeoutMs === null) return null
    const where = coin && network ? ` (${coin} ${network})` : ''
    let created
    if (settings.stopTimeout !== budgetSeconds) {
        created = Number.isInteger(settings.stopTimeout)
            ? `under a ${settings.stopTimeout} s stop budget` : 'without a stop budget'
    } else if (settings.shutdownTimeoutMs === null && !isDefaultStopBudget(module, budgetSeconds)) {
        created = 'before the node forwarded SHUTDOWN_TIMEOUT_MS'
    } else {
        return null
    }
    return `WARNING: ${module}${where} was created ${created}, so its own drain timer does not follow ` +
        `${moduleStopTimeoutEnvName(module)} (now ${budgetSeconds} s). Recreate it (xchain-node recreate) so the ` +
        'node forwards SHUTDOWN_TIMEOUT_MS from the current budget.'
}

// SIGTERM's default action (128 + 15): a process with no drain registered,
// or npm relaying its child's, which is how a drainless service always stops.
const EXIT_ON_SIGTERM_DEFAULT = 143

// A stop inside the budget that still ended non-zero. The drains exit 1 when
// their own hard-exit timer fires or the drain throws, so work was cut off
// even though docker never had to kill anything.
function stoppedUnclean(outcome) {
    return Boolean(outcome && outcome.stopped && !outcome.killed &&
        Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0 &&
        outcome.exitCode !== EXIT_ON_SIGTERM_DEFAULT)
}

// What the operator reads after a service was stopped. A stop that ran out of
// budget is a kill, and a killed decoder may have been mid-rollback; that is
// worth a warning line, not silence, and so is a drain the service cut off
// itself. Returns null when there was nothing to stop (already gone), because
// the caller's remove or run surfaces that.
function describeModuleStopOutcome(module, coin, network, outcome, budgetSeconds) {
    if (!outcome || !outcome.stopped) return null
    const where = coin && network ? ` (${coin} ${network})` : ''
    if (outcome.killed) {
        return `WARNING: ${module}${where} did not exit within the ${budgetSeconds} s budget and was killed. ` +
            `Raise ${moduleStopTimeoutEnvName(module)} if this service needs longer to finish its block; the node ` +
            'derives the service\'s own SHUTDOWN_TIMEOUT_MS from it when the container is next recreated, unless ' +
            'the module config sets one.'
    }
    if (stoppedUnclean(outcome)) {
        return `WARNING: ${module}${where} exited with code ${outcome.exitCode} after ${outcome.seconds} s, inside the ` +
            `${budgetSeconds} s budget, so its shutdown drain did not complete: it overran the service's own ` +
            'hard-exit timer (SHUTDOWN_TIMEOUT_MS where the service reads one) or failed. Check the service log. ' +
            `Raising ${moduleStopTimeoutEnvName(module)} gives that drain more time only once the container is ` +
            'recreated, and not while the module config sets SHUTDOWN_TIMEOUT_MS.'
    }
    return `Stopped ${module}${where} cleanly in ${outcome.seconds} s (budget ${budgetSeconds} s).`
}

// One stop for every CLI path that takes a service container down: stop with
// the budget, say what happened, return the outcome so the caller can decide
// whether a kill matters to it. `stopContainerByName` accepts an id as well
// as a name (docker echoes back whatever it was given). `readStopSettings`,
// when given, reads the container first so a drain that predates the current
// budget is named before the stop rather than after a kill.
async function stopModuleContainer(stopContainerByName, module, coin, network, containerRef,
    env = MODULE_STOP_TIMEOUT_ENV, readStopSettings = null) {
    const budget = moduleStopTimeoutSeconds(module, env)
    if (typeof readStopSettings === 'function' && module !== 'node') {
        const settings = await Promise.resolve().then(() => readStopSettings(containerRef)).catch(() => null)
        const drift = describeStopBudgetDrift(module, coin, network, settings, budget)
        if (drift) logger.warn(drift)
    }
    const outcome = await stopContainerByName(containerRef, budget)
    const line = describeModuleStopOutcome(module, coin, network, outcome, budget)
    if (line) {
        if (outcome.killed || stoppedUnclean(outcome)) logger.warn(line)
        else logger.info(line)
    }
    return { ...outcome, budget }
}

module.exports = {
    DEFAULT_MODULE_STOP_TIMEOUT_SECONDS,
    MODULE_STOP_TIMEOUT_SECONDS,
    moduleStopTimeoutEnvName,
    moduleStopTimeoutSeconds,
    stopTimeoutArgs,
    STOP_DRAIN_MARGIN_MS,
    moduleShutdownTimeoutMs,
    shutdownTimeoutEnv,
    describeStopBudgetDrift,
    stoppedUnclean,
    describeModuleStopOutcome,
    stopModuleContainer
}
