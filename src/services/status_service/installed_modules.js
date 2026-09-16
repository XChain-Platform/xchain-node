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
 * XChain Node - Status Service
 * Tracks installed modules and container status
 ********************************************************************/

let { db, getInstalledModules } = require('../../state')
let { checkRemoteNodeVersion } = require('../version_service')
let { redactSecrets } = require('../../utils/helpers')
let { getLogger } = require('../../observability/logger');
let logger = getLogger();

function configureDependencies(dependencies) {
    ;({ db, getInstalledModules, checkRemoteNodeVersion, redactSecrets, getLogger, logger } = dependencies)
}

// The remote node version is ADVISORY: it fills one column of the status table
// and gates nothing. checkRemoteNodeVersion reaches the GitHub releases API, so
// a 403 rate limit (measured on a validator host 2026-09-12) or an unreachable
// network rejects it, so both call sites below swallow that rejection. An
// escaping rejection travels through getStatus into precheck, which aborts the
// whole command: `update` refuses to deploy, modules override or not, and
// `status` refuses to print a table it already has every other column for.
// precheck degrades the module-version sweep (checkAllRemoteVersions) exactly
// this way; this is the per-coin half.
//
// One warning per status pass, not one per coin: a three-coin host would
// otherwise print the same GitHub failure three times. The flag is cleared at
// the top of loadInstalledModules, which every getStatus pass runs before the
// per-coin loop reaches the second call site.
let remoteVersionWarned = false

async function checkRemoteNodeVersionAdvisory(coin, network) {
    try {
        await checkRemoteNodeVersion(coin, network)
        return true
    } catch (err) {
        if (!remoteVersionWarned) {
            remoteVersionWarned = true
            // The message, not the stack: this is an advisory line an operator
            // reads mid-deploy, and the precheck sweep's equivalent warning is
            // one line too. redactSecrets still runs over it (a credentialed URL
            // can reach an axios message).
            logger.info("Warning: couldn't fetch the remote node version"
                + (coin ? " for " + coin : "")
                + " (GitHub unreachable or rate-limited); continuing without version check: "
                + redactSecrets((err && err.message) ? err.message : err))
        }
        return false
    }
}

async function loadInstalledModules(coin, network, checkVersions = false) {
    remoteVersionWarned = false
    if (checkVersions) await checkRemoteNodeVersionAdvisory(coin, network)
    const modules = await db.getAllModuleContainers(coin, network)

    for (const nextModule of modules) {
        const { module, coin: c, network: n, container_id } = nextModule
        const installedModules = getInstalledModules()

        if (!(c in installedModules)) installedModules[c] = {}
        if (!(n in installedModules[c])) installedModules[c][n] = {}
        if (!(module in installedModules[c][n])) installedModules[c][n][module] = {}

        installedModules[c][n][module]["container_id"] = container_id
    }
}

module.exports = { checkRemoteNodeVersionAdvisory, loadInstalledModules, configureDependencies }
