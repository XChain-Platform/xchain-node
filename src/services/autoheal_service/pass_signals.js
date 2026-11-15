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
 * XChain Node - Autoheal pass signals
 *
 * What one autoheal pass reports to its caller: how a failed `docker inspect`
 * is classified, the closing log line, and the CLI exit code.
 ********************************************************************/

const { getLogger } = require('../../observability/logger');
const logger = getLogger();

const MAX_ERROR_TEXT = 200

// Docker SAYING "no such object/container" is the only thing that means the
// container is gone (same rule as StatusService.isContainerGoneError). Anything
// else (a dead daemon, a socket permission error, a timeout) says nothing about the container and must not read as a clean pass.
function isInspectGoneError(err) {
    if (!err) return false
    const text = String((err.stderr || '') + ' ' + (err.message || '')).toLowerCase()
    return /no such (object|container)/.test(text)
}

// The first line of docker's own words, without the `Command failed: ...` header
// execFile prefixes, so the log line and the skipped row carry the cause.
function inspectErrorText(err) {
    const raw = String((err && (err.stderr || err.message)) || err)
    const lines = raw.split('\n').map(line => line.trim()).filter(line => line && !/^Command failed:/.test(line))
    return (lines[0] || raw.trim()).slice(0, MAX_ERROR_TEXT)
}

// Files one failed inspect. A gone container stays a quiet skip (the registry
// reconcile on the next precheck cleans it up); any other error is logged at
// error level and counted so the pass can exit non-zero.
function recordInspectFailure(candidate, err, result) {
    const { module, coin, network, containerId, label } = candidate
    if (isInspectGoneError(err)) {
        result.skipped.push({ module, coin, network, containerId, reason: 'inspect failed' })
        return
    }
    const error = inspectErrorText(err)
    result.inspectErrors.push({ module, coin, network, containerId, error })
    result.skipped.push({ module, coin, network, containerId, reason: `inspect error: ${error}` })
    logger.error(`autoheal: cannot inspect ${label}: ${error}`)
}

// The closing line. An empty candidate list is "nothing to do" only when every
// opted-in container could be inspected.
function logPassSummary(result) {
    if (result.inspectErrors.length > 0) {
        logger.error(`autoheal: could not inspect ${result.inspectErrors.length} opted-in container(s); Docker may be unreachable`)
        return
    }
    if (result.candidates.length === 0) logger.info('autoheal: nothing to do')
}

// The CLI exit code for one pass: 1 when a restart failed, 2 when a wedge
// outlived two restarts, 3 when an opted-in container could not be inspected
// for a reason other than being gone, else 0.
function autohealExitCode(result) {
    if (result.failed.length > 0) return 1
    if (result.escalated && result.escalated.length > 0) return 2
    if (result.inspectErrors && result.inspectErrors.length > 0) return 3
    return 0
}

module.exports = { isInspectGoneError, inspectErrorText, recordInspectFailure, logPassSummary, autohealExitCode }
