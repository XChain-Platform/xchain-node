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
 * XChain Node - Node Service: coin node stop budget
 * Shutdown budget for a chain daemon container and the outcome line
 ********************************************************************/

const config = require('../../config');
const { getLogger } = require('../../observability/logger');
const logger = getLogger();

// Shutdown budget for a chain daemon container, in seconds. A daemon flushes
// its block index and chainstate only on a clean shutdown, and a mainnet
// bitcoind with a large dbcache can take minutes to do it. `docker stop`
// returns as soon as the process exits, so a wide budget costs nothing on the
// common path and only matters when the flush is genuinely slow.
//
// The default is unmeasured against the slowest box the docs name (a Pi
// flushing a 3 GB dbcache to a USB SSD), so XCHAIN_NODE_STOP_TIMEOUT_SECONDS
// overrides it; the stop logs the budget it used and how long the daemon
// took, and a stop that ran out of budget is reported as the kill it was.
const DEFAULT_NODE_STOP_TIMEOUT_SECONDS = 600
const NODE_STOP_TIMEOUT_ENV = 'XCHAIN_NODE_STOP_TIMEOUT_SECONDS'

function nodeStopTimeoutSeconds() {
    // Read by name, not through the constant: the env-var doc gate scans reads
    // by name, and a computed read is invisible to it.
    const raw = config.XCHAIN_NODE_STOP_TIMEOUT_SECONDS
    if (raw === undefined || String(raw).trim() === '') return DEFAULT_NODE_STOP_TIMEOUT_SECONDS
    const seconds = parseInt(raw, 10)
    if (!Number.isFinite(seconds) || seconds < 1 || String(seconds) !== String(raw).trim()) {
        logger.warn(`${NODE_STOP_TIMEOUT_ENV}=${raw} is not a whole number of seconds; using the default ${DEFAULT_NODE_STOP_TIMEOUT_SECONDS}`)
        return DEFAULT_NODE_STOP_TIMEOUT_SECONDS
    }
    return seconds
}

// What the operator reads after the previous daemon was stopped. Silence was
// the failure mode: a mainnet bitcoind killed at the budget came back 17000
// blocks lower and re-validated for four hours, and nothing in the update's
// output said the stop had not been clean.
function describeNodeStopOutcome(coin, network, outcome, budgetSeconds) {
    if (!outcome || !outcome.stopped) return null
    if (outcome.killed) {
        return `WARNING: the ${coin} ${network} daemon did not exit within the ${budgetSeconds} s budget and was killed. ` +
            `It will come back at its last flushed state and re-validate from there, which can take hours on a large dbcache. ` +
            `Raise ${NODE_STOP_TIMEOUT_ENV} above the time this daemon needs to flush before the next update.`
    }
    if (nodeStoppedUnclean(outcome)) {
        return `WARNING: the ${coin} ${network} daemon exited with code ${outcome.exitCode} after ${outcome.seconds} s ` +
            `(budget ${budgetSeconds} s), not cleanly. Check its debug.log before assuming the chainstate was flushed.`
    }
    return `Stopped the ${coin} ${network} daemon cleanly in ${outcome.seconds} s (budget ${budgetSeconds} s).`
}

// A daemon that left inside the budget with a non-zero code exited on an
// error, not a clean flush.
function nodeStoppedUnclean(outcome) {
    return Boolean(outcome && outcome.stopped && !outcome.killed &&
        Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0)
}

module.exports = {
    DEFAULT_NODE_STOP_TIMEOUT_SECONDS,
    NODE_STOP_TIMEOUT_ENV,
    nodeStopTimeoutSeconds,
    describeNodeStopOutcome,
    nodeStoppedUnclean
}
