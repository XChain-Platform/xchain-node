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
 * XChain Node - Interactive UI / Module choices
 ********************************************************************/

const { NODE_MODULE_NAME, DB_MODULE_NAME, XChainService, Network } = require('../../config')

// Lists the modules a network can run: its services plus the node and the database.
function expectedModules(network) {
    let allModules = Object.values(XChainService)

    const e2eIndex = allModules.indexOf(XChainService.XCHAIN_E2E_TEST)
    if (e2eIndex >= 0) allModules.splice(e2eIndex, 1)

    if (network !== Network.REGTEST) {
        const regtestIndex = allModules.indexOf(XChainService.XCHAIN_REGTEST_MINER)
        if (regtestIndex >= 0) allModules.splice(regtestIndex, 1)
    }

    allModules.push(NODE_MODULE_NAME)
    allModules.push(DB_MODULE_NAME)
    return allModules
}

// Builds the module list choices and maps each choice key to its module and status.
function buildModuleChoices(modulesStatus, coin, network) {
    const moduleChoices = []
    const actionModules = {}

    let onlyOneModuleUsingDatabase = false

    if ((coin in modulesStatus) && (network in modulesStatus[coin])) {
        onlyOneModuleUsingDatabase = !((modulesStatus.length > 2) || (modulesStatus[coin].length > 1))

        if (("" in modulesStatus) && ("" in modulesStatus[""]) && (DB_MODULE_NAME in modulesStatus[""][""])) {
            modulesStatus[coin][network][DB_MODULE_NAME] = modulesStatus[""][""][DB_MODULE_NAME]
        }

        let allModules = expectedModules(network)

        for (const mod in modulesStatus[coin][network]) {
            const moduleStatus = modulesStatus[coin][network][mod]["status"]["State"]["Status"]
            const color = moduleStatus === "exited" ? "\x1b[31m" : "\x1b[32m"
            const key = color + mod + " (" + moduleStatus + ")" + "\x1b[37m"

            moduleChoices.push({ name: key, value: mod })
            actionModules[key] = {
                "value": mod,
                "container_id": modulesStatus[coin][network][mod]["container_id"],
                "status": moduleStatus
            }

            const idx = allModules.indexOf(mod)
            if (idx !== -1) allModules.splice(idx, 1)
        }

        for (const mod of allModules) {
            const key = "\x1b[34m" + mod + " (missing)\x1b[37m"
            moduleChoices.push({ name: key, value: mod })
            actionModules[key] = { "value": mod, "status": "missing" }
        }

        moduleChoices.push({ name: "Uninstall all the modules", value: "Uninstall all the modules" })
        moduleChoices.push({ name: "Return", value: "return" })
    } else {
        moduleChoices.push({ name: "Install the node", value: "Install the node" })
        moduleChoices.push({ name: "Return", value: "return" })
    }

    if (network === Network.REGTEST) {
        moduleChoices.splice(moduleChoices.length - 2, 0, { name: "Perform an E2E test", value: "e2etest" })
    }
    return { moduleChoices, actionModules }
}

module.exports = { expectedModules, buildModuleChoices }
