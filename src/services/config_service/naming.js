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
 * Config Service Naming Helpers
 ********************************************************************/

'use strict'

function configure(dependencies) {
    const {
        NODE_PREFIX, DEFAULT_NODE_PREFIX, SEP, DB_SEP,
        DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
        CoinTickerSymbol, Network, XChainService, scopedNodePrefixSegment
    } = dependencies

    function getDockerContainerImageNamePrefix(module, coin, network) {
        if ([DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME].includes(module)) {
            return NODE_PREFIX
        }
        return NODE_PREFIX + SEP + coin + SEP + network
    }

    function getDockerContainerImageName(module, coin, network) {
        return getDockerContainerImageNamePrefix(module, coin, network) + SEP + module
    }

    function getUtxoTrackerVolumeName(coin, network) {
        const prefix = NODE_PREFIX === DEFAULT_NODE_PREFIX ? '' : `${NODE_PREFIX}${SEP}`
        return `${prefix}${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${coin}-${network}-data`
    }

    function getDockerNetwork(coin, network) {
        return NODE_PREFIX
            + (coin !== "" ? SEP + coin : "")
            + (network !== "" ? SEP + network : "")
    }

    const getModuleDatabaseName = function (module, coin, network) {
        if (coin !== "" && CoinTickerSymbol[coin] === undefined) {
            throw new Error("Unknown coin '" + coin + "'; cannot derive a database name")
        }
        if (network !== "" && !Object.values(Network).includes(network)) {
            throw new Error("Unknown network '" + network + "'; cannot derive a database name")
        }
        const moduleName = module.slice("xchain-".length)
        return "XChain" + DB_SEP
            + scopedNodePrefixSegment(NODE_PREFIX, DEFAULT_NODE_PREFIX, DB_SEP)
            + CoinTickerSymbol[coin] + DB_SEP
            + network.charAt(0).toUpperCase() + network.slice(1) + DB_SEP
            + moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
    }

    function applyPrefixedModuleDbUsers(defaultValues, coin, network) {
        const segment = scopedNodePrefixSegment(NODE_PREFIX, DEFAULT_NODE_PREFIX, DB_SEP)
        if (segment === '') return
        for (const [key, name] of [["DECODER_DB_USER", "decoder"], ["INDEXER_DB_USER", "indexer"]]) {
            defaultValues[key] = "xchain" + DB_SEP + segment + name + DB_SEP + coin + DB_SEP + network
        }
    }

    Object.assign(module.exports, {
        getDockerContainerImageNamePrefix,
        getDockerContainerImageName,
        getUtxoTrackerVolumeName,
        getDockerNetwork,
        getModuleDatabaseName,
        applyPrefixedModuleDbUsers
    })
}

module.exports = { configure }
