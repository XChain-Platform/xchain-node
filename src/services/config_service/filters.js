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
 * Config Service Command Filters
 ********************************************************************/

'use strict'

let Coin, Network, XChainService, REGTEST_MODULES
let NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME

function configure(dependencies) {
    ({ Coin, Network, XChainService, REGTEST_MODULES,
        NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME } = dependencies)
}

// Short names operators actually type for the shared services, whose canonical
// names carry an `xchain-` prefix that is easy to omit. 'explorer' already had
// this treatment; the others did not, so `recreate hub` matched no container and
// looked like the hub was simply unsupported.
function serviceAliases() {
    return { hub: HUB_MODULE_NAME, sync: SYNC_MODULE_NAME, db: DB_MODULE_NAME }
}

// Callers that bypass resolveArgs (recreate, start/stop/restart, logs) hand
// the operator's raw token straight through, so the alias map has to apply
// here too.
// Shared services (hub / explorer / db / sync) are registered under a single
// empty coin+network key, not per-coin. A bare `update xchain-hub` must resolve
// to that ""/"" container; otherwise it gets fanned out across real coins where
// it matches nothing and the command silently no-ops.
// The coin node leads the per-chain list so `install all` creates it
// before the services that poll it. With the node last, a mainnet
// install created the decoder four and a half hours before the node
// existed (a 151 GiB tracker restore sat between them); the decoder
// spent that time logging ENOTFOUND for a name the network did not
// carry yet, and the node's own initial sync, the slowest step on the
// box, had not even started. Every other command that expands `all`
// (update, start, stop, uninstall) tolerates either order.
// Explicitly-named shared service → emit under the empty ""/"" key only.
function filterCommandParameters(branch, modules, coins, networks) {
    const servicesList = {}
    let addExplorer = false
    const aliases = serviceAliases()
    if (modules && aliases[modules]) modules = aliases[modules]
    coins = coins && coins !== "all" ? [coins] : Object.values(Coin)
    networks = networks && networks !== "all" ? [networks] : Object.values(Network)
    const sharedServices = [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, DB_MODULE_NAME, SYNC_MODULE_NAME]
    if (modules === "all") {
        modules = [NODE_MODULE_NAME, ...Object.values(XChainService).filter(m => m !== XChainService.XCHAIN_E2E_TEST)]
        addExplorer = true
    } else if (modules === "explorer") {
        addExplorer = true
        coins = []
    } else if (sharedServices.includes(modules)) {
        return { "": { "": [modules] } }
    } else if (modules === "node") {
        modules = [NODE_MODULE_NAME]
    } else if (modules) {
        modules = [modules]
    }
    if (addExplorer) servicesList[""] = { "": [EXPLORER_MODULE_NAME] }
    for (const nextCoin of coins) {
        if (!(nextCoin in servicesList)) servicesList[nextCoin] = {}
        for (const nextNetwork of networks) {
            if (!(nextNetwork in servicesList[nextCoin])) servicesList[nextCoin][nextNetwork] = []
            for (const nextModule of modules) {
                if (!REGTEST_MODULES.includes(nextModule) || nextNetwork === Network.REGTEST) {
                    servicesList[nextCoin][nextNetwork].push(nextModule)
                }
            }
        }
    }
    return servicesList
}

module.exports = { configure, serviceAliases, filterCommandParameters }
