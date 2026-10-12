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

// Whether a service honours this SHUTDOWN_TIMEOUT_MS. The services parse it with
// parseInt and fall back to their own default unless it is a positive number.
function serviceHonoursShutdownMs(value) {
    if (value === undefined || value === null) return false
    const ms = parseInt(value, 10)
    return Number.isFinite(ms) && ms > 0
}

// A SHUTDOWN_TIMEOUT_MS the service would honour that is at or above the stop
// budget, so docker's kill always lands first. Null when the value is under the
// budget or one the service would ignore.
function overBudgetShutdownMs(value, budgetSeconds) {
    if (!serviceHonoursShutdownMs(value)) return null
    const ms = parseInt(value, 10)
    return ms >= budgetSeconds * 1000 ? ms : null
}

// The container env entry that carries the derived drain budget. A valid explicit
// SHUTDOWN_TIMEOUT_MS wins and nothing is added, as for a null module (a one-shot run
// has no budget). An ignored one counts as unset, since the service's own default only
// fits the default budget. Warn on an explicit value docker could kill first or ignored.
function shutdownTimeoutEnv(module, moduleConfig, env = MODULE_STOP_TIMEOUT_ENV) {
    if (!module) return {}
    const configured = moduleConfig ? moduleConfig.SHUTDOWN_TIMEOUT_MS : undefined
    const explicit = configured !== undefined && configured !== null && String(configured).trim() !== ''
    if (module === 'node') return {}
    const budget = moduleStopTimeoutSeconds(module, env)
    if (explicit && serviceHonoursShutdownMs(configured)) {
        const over = overBudgetShutdownMs(configured, budget)
        if (over !== null) logger.warn(overBudgetShutdownLine(module, '', over, budget, 'the module config sets'))
        return {}
    }
    const derived = shutdownTimeoutMsForBudget(module, budget)
    if (explicit) logger.warn(ignoredShutdownLine(module, configured, derived, budget))
    return derived === null ? {} : { SHUTDOWN_TIMEOUT_MS: String(derived) }
}

// The operator line for an explicit SHUTDOWN_TIMEOUT_MS the service would ignore.
function ignoredShutdownLine(module, raw, derived, budgetSeconds) {
    const instead = derived === null ? 'the service keeps its own default'
        : `the node is forwarding ${derived}, derived from the ${budgetSeconds} s stop budget, in its place`
    return `WARNING: ${module}: the module config sets SHUTDOWN_TIMEOUT_MS=${raw}, which the service ignores ` +
        `because it is not a positive number of milliseconds, so ${instead}. Correct or remove it in the module config.`
}

// The operator line for a drain timer at or above its stop budget.
function overBudgetShutdownLine(module, where, ms, budgetSeconds, source) {
    return `WARNING: ${module}${where}: ${source} SHUTDOWN_TIMEOUT_MS=${ms}, at or above its ${budgetSeconds} s stop ` +
        'budget, so a drain that runs long is killed by docker before the service\'s own timer can end it. Lower ' +
        `SHUTDOWN_TIMEOUT_MS in the module config below ${budgetSeconds * 1000} (or remove it so the node derives it), ` +
        `or raise ${moduleStopTimeoutEnvName(module)}, then recreate the container (xchain-node recreate).`
}

// Why a running service's own drain may not follow its current budget: the
// container carries a different stamped budget, it predates the forwarded
// SHUTDOWN_TIMEOUT_MS while an override is set, or it carries a drain timer at
// or above the budget. Null when nothing drifted, the container could not be
// read, or neither side involves a forwarded drain.
function describeStopBudgetDrift(module, coin, network, settings, budgetSeconds) {
    if (!settings || module === 'node') return null
    // A carried value the service ignores leaves its own default timer, the same as none at all
    const carried = serviceHonoursShutdownMs(settings.shutdownTimeoutMs) ? settings.shutdownTimeoutMs : null
    const forwards = shutdownTimeoutMsForBudget(module, budgetSeconds) !== null
    if (!forwards && carried === null) return null
    const where = coin && network ? ` (${coin} ${network})` : ''
    let created
    if (settings.stopTimeout !== budgetSeconds) {
        created = Number.isInteger(settings.stopTimeout)
            ? `under a ${settings.stopTimeout} s stop budget` : 'without a stop budget'
    } else if (carried === null && !isDefaultStopBudget(module, budgetSeconds)) {
        const raw = settings.shutdownTimeoutMs
        created = raw === null || raw === undefined || String(raw).trim() === ''
            ? 'before the node forwarded SHUTDOWN_TIMEOUT_MS'
            : `with SHUTDOWN_TIMEOUT_MS=${raw}, which the service ignores,`
    } else {
        // Flag a drain timer docker's kill would beat, before the stop rather than after it
        const over = overBudgetShutdownMs(carried, budgetSeconds)
        return over === null ? null : overBudgetShutdownLine(module, where, over, budgetSeconds, 'the container carries')
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
            'the module config sets a valid one.'
    }
    if (stoppedUnclean(outcome)) {
        return `WARNING: ${module}${where} exited with code ${outcome.exitCode} after ${outcome.seconds} s, inside the ` +
            `${budgetSeconds} s budget, so its shutdown drain did not complete: it overran the service's own ` +
            'hard-exit timer (SHUTDOWN_TIMEOUT_MS where the service reads one) or failed. Check the service log. ' +
            `Raising ${moduleStopTimeoutEnvName(module)} gives that drain more time only once the container is ` +
            'recreated, and not while the module config sets a valid SHUTDOWN_TIMEOUT_MS.'
    }
    return `Stopped ${module}${where} cleanly in ${outcome.seconds} s (budget ${budgetSeconds} s).`
}

// Return the -t for a stop: at least the budget the container was stamped with (its
// drain timer was sized to it), or a listed service's default when it has no stamp.
function effectiveStopBudgetSeconds(module, settings, budgetSeconds) {
    if (!settings || module === 'node') return budgetSeconds
    const floor = Number.isInteger(settings.stopTimeout) ? settings.stopTimeout : MODULE_STOP_TIMEOUT_SECONDS[module]
    return Number.isInteger(floor) && floor > budgetSeconds ? floor : budgetSeconds
}

// Read a container's stamped stop settings, loading docker_service at call time.
function readContainerStopSettings(containerRef) {
    return require('./docker_service').getContainerStopSettings(containerRef)
}

// One stop for every CLI path that takes a service container down: stop with
// the budget, say what happened, return the outcome so the caller can decide
// whether a kill matters to it. `stopContainerByName` accepts an id as well
// as a name (docker echoes back whatever it was given). The container is read
// first (pass null to skip) so a drain that predates the current budget is named
// before the stop and still gets the budget it was created under.
async function stopModuleContainer(stopContainerByName, module, coin, network, containerRef,
    env = MODULE_STOP_TIMEOUT_ENV, readStopSettings = readContainerStopSettings) {
    let budget = moduleStopTimeoutSeconds(module, env)
    if (typeof readStopSettings === 'function' && module !== 'node') {
        const settings = await Promise.resolve().then(() => readStopSettings(containerRef)).catch(() => null)
        const drift = describeStopBudgetDrift(module, coin, network, settings, budget)
        if (drift) logger.warn(drift)
        const effective = effectiveStopBudgetSeconds(module, settings, budget)
        if (effective > budget) {
            logger.info(`Stopping ${module} with ${effective} s, the budget its drain timer was sized to, not the ` +
                `current ${budget} s, so its drain can finish; the current budget applies once it is recreated.`)
            budget = effective
        }
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
    effectiveStopBudgetSeconds,
    stoppedUnclean,
    describeModuleStopOutcome,
    stopModuleContainer
}
