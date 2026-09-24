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
 * Config Service Arguments
 ********************************************************************/

'use strict'

let Coin, Network, XChainService, NODE_MODULE_NAME, DB_MODULE_NAME
let HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, releaseManifestService, serviceAliases

function configure(dependencies) {
    ({ Coin, Network, XChainService, NODE_MODULE_NAME, DB_MODULE_NAME,
        HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, releaseManifestService, serviceAliases } = dependencies)
}

// 'xchain-node' is the CLI itself, not an installable service. Without this
// guard the loop silently drops it and leaves service='all', so e.g.
// `install master xchain-node` would expand to EVERY service. Fail loudly.
// Nothing claimed this token. The 'xchain-node' guard above exists
// because a dropped token leaves service='all', and that trap is not
// specific to that one name: `install master hub` silently expanded to
// EVERY service on every coin and network rather than refusing. An
// operator reaching for one service must never get all of them.
// Classify the ref slot by shape rather than adding a second CLI field
// (operator-confirmed 2026-08-13, release-management spec section 11). The
// caller decides what to do with it; resolveArgs only reports the shape, so
// this stays a pure function with no network in it.
function resolveArgs(args, { expectBranch = false, defaultBranch = 'master' } = {}) {
    const SERVICE_ALIASES = serviceAliases()
    let service = 'all', chain = 'all', network = 'all', branch = null
    const knownServices = [
        ...Object.values(XChainService),
        NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME,
        EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, 'explorer'
    ]
    const knownChains   = Object.values(Coin)
    const knownNetworks = Object.values(Network)
    for (const arg of args) {
        if (!arg || arg === 'all') continue
        if (arg === 'xchain-node') {
            throw new Error("'xchain-node' is the CLI itself, not an installable service. Omit it to operate on all services, or name a specific one (e.g. xchain-indexer, xchain-decoder, xchain-hub).")
        }
        const aliased = SERVICE_ALIASES[arg]
        if (knownChains.includes(arg)) {
            chain = arg
        } else if (knownNetworks.includes(arg)) {
            network = arg
        } else if (knownServices.includes(arg)) {
            service = arg
        } else if (aliased) {
            service = aliased
        } else if (expectBranch && !branch) {
            branch = arg
        } else {
            throw new Error(`Unrecognized argument '${arg}'. Valid services: ` +
                knownServices.filter(s => s !== 'explorer').sort().join(', ') + '. ' +
                `Valid coins: ${knownChains.join(', ')}. Networks: ${knownNetworks.join(', ')}.`)
        }
    }
    if (expectBranch && !branch) branch = defaultBranch
    if (branch && !/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
        throw new Error("Invalid branch name: " + branch + " (branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes)")
    }
    const { isReleaseRef } = releaseManifestService
    return { service, chain, network, branch, isRelease: isReleaseRef(branch) }
}

module.exports = { configure, resolveArgs }
