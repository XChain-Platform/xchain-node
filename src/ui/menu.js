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
 * XChain Node - Interactive UI / Menu
 ********************************************************************/

const { Select } = require('enquirer')
const semver    = require('semver')

const {
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    XChainService, Coin, Network, SEP
} = require('../config')
const { db, getRemoteModuleVersions }   = require('../state')
const { getStatus, statusChanged }       = require('../services/status_service')
const { redactSecrets }                  = require('../utils/helpers')
const { cloneGit, installModule } = require('../services/module_service')
const { installModules, uninstallModules, updateModules, restartModules, logModules, runE2ETest } = require('../operations/module_operations')
const { installNode }                    = require('../services/node_service')
const { makeBootstrap }                  = require('../services/bootstrap_service')
const {
    getLocalNodeVersion, getLocalModuleVersion,
    getContainerNodeVersion, getContainerModuleVersion
} = require('../services/version_service')
const { scanAndRegisterModules } = require('../services/discovery_service')
const { restoreBootstrapInterface } = require('./menu/restore_bootstrap_prompt.js')

// Per-module action labels. enquirer's Select resolves to a choice's NAME, so the
// label the menu offers and the string the handler branches on must be the same
// value - shared here rather than typed twice, because when they drifted apart the
// menu entry simply did nothing and returned the operator to the module list.
const ACTION_UPDATE_LOCAL              = "Update local version"
const ACTION_REINSTALL_REMOTE          = "Reinstall from remote"
const ACTION_UPDATE_CONTAINER          = "Update Container"
const ACTION_REINSTALL_CONTAINER       = "Reinstall"
const ACTION_INSTALL_LOCAL_IN_CONTAINER = "Install Local Version in Container"

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

// Reads the remote and local versions of a module, "0" for one that is unavailable.
async function readModuleVersions(selectedValue, remoteModuleVersions, coin, network) {
    let remoteVersion = "0"
    try {
        remoteVersion = selectedValue === NODE_MODULE_NAME
            ? await remoteModuleVersions[selectedValue + SEP + coin]["version"]
            : await remoteModuleVersions[selectedValue]
    } catch { /* not available */ }

    let localVersion = "0"
    try {
        localVersion = selectedValue === NODE_MODULE_NAME
            ? await getLocalNodeVersion(coin, network)
            : await getLocalModuleVersion(selectedValue)
    } catch { /* not available */ }
    return { remoteVersion, localVersion }
}

// Lists an installed module's actions from its status and version comparisons.
function installedModuleActions(selectedStatus, selectedValue, localVersion, remoteVersion, containerVersion) {
    const moduleActions = [{ name: "Tail logs", value: "tail" }]

    if (selectedStatus === "exited") moduleActions.push({ name: "Restart", value: "restart" })

    // enquirer's Select resolves to a choice's NAME, so the handler below must
    // branch on these exact strings, or picking one runs nothing and drops back
    // to the module list. Shared constants keep both sides renamed together.
    if (semver.valid(localVersion)) {
        if (semver.valid(remoteVersion)) {
            if (semver.gt(remoteVersion, localVersion)) {
                moduleActions.push({ name: ACTION_UPDATE_LOCAL, value: "update local version" })
            } else if (semver.eq(remoteVersion, localVersion)) {
                moduleActions.push({ name: ACTION_REINSTALL_REMOTE, value: "reinstall from remote" })
            }
        }
        if (semver.valid(containerVersion)) {
            if (semver.gt(localVersion, containerVersion)) {
                moduleActions.push({ name: ACTION_UPDATE_CONTAINER, value: "update container" })
            } else {
                moduleActions.push({ name: ACTION_REINSTALL_CONTAINER, value: "reinstall container" })
            }
        } else {
            moduleActions.push({ name: ACTION_INSTALL_LOCAL_IN_CONTAINER, value: "install local version in container" })
        }
    } else if (semver.valid(remoteVersion)) {
        moduleActions.push({ name: ACTION_UPDATE_LOCAL, value: "update local version" })
    }

    const sharedModules = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]
    if (!sharedModules.includes(selectedValue)) {
        moduleActions.push({ name: "Uninstall", value: "uninstall" })
        if (selectedValue === XChainService.XCHAIN_UTXO_TRACKER) {
            moduleActions.push({ name: "Make Bootstrap", value: "make_bootstrap" })
            moduleActions.push({ name: "Restore Bootstrap", value: "restore_bootstrap" })
        }
    }
    moduleActions.push({ name: "Return", value: "return" })
    return moduleActions
}

// Asks which action to run on the selected module; ESC answers "Return".
async function promptModuleAction(moduleActions) {
    const actionSelect = new Select({
        name: 'action',
        message: 'What do you want to do with the selected module?',
        choices: moduleActions
    })
    const actionAnswer = await actionSelect.run().catch(() => "Return")
    return actionAnswer
}

// Runs the action the operator picked for an installed module.
async function runInstalledModuleAction(actionAnswer, selected, coin, network) {
    const selectedValue = selected["value"]
    if (actionAnswer === "Return") {
        // ESC or Return: go back to module list
    } else if (actionAnswer === "Uninstall") {
        try {
            await uninstallModules({ [coin]: { [network]: [selectedValue] } })
        } catch (err) {
            console.log(redactSecrets(err))
        }
    } else if (actionAnswer === "Restart") {
        try {
            await restartModules({ [coin]: { [network]: [selectedValue] } })
        } catch (err) {
            console.log(redactSecrets(err))
        }
    } else if (actionAnswer === ACTION_UPDATE_LOCAL) {
        await cloneGit(selectedValue, true, false)
    } else if (actionAnswer === ACTION_UPDATE_CONTAINER
            || actionAnswer === ACTION_INSTALL_LOCAL_IN_CONTAINER
            || actionAnswer === ACTION_REINSTALL_CONTAINER) {
        // All three rebuild the container from the local checkout; they differ only
        // in how the menu describes the version relationship that led the operator here.
        await installModule(selectedValue, coin, network, false, selected["container_id"])
    } else if (actionAnswer === "Make Bootstrap") {
        try {
            await makeBootstrap(coin, network, selectedValue)
        } catch (err) {
            // A source-health refusal is an expected outcome here, so
            // print the reasons and stay in the menu rather than
            // tearing the TUI down with a stack trace.
            if (err && err.name === 'BootstrapSourceUnhealthyError') console.log(redactSecrets(err.message))
            else console.log(redactSecrets(err))
        }
    } else if (actionAnswer === "Restore Bootstrap") {
        try {
            await restoreBootstrapInterface(coin, network, selectedValue)
        } catch (err) {
            // Same contract as "Make Bootstrap" above: an integrity
            // refusal is an expected outcome, so report it and stay in
            // the TUI instead of tearing it down with a stack trace.
            if (err && err.name === 'BootstrapIntegrityError') console.log(redactSecrets(err.message))
            else throw err
        }
    } else if (actionAnswer === ACTION_REINSTALL_REMOTE) {
        await updateModules({ [coin]: { [network]: [selectedValue] } })
    } else if (actionAnswer === "Tail logs") {
        await logModules({ [coin]: { [network]: [selectedValue] } })
    }
}

// Reads an installed module's container version, then offers and runs its actions.
async function manageInstalledModule(selected, coin, network, localVersion, remoteVersion) {
    const selectedValue = selected["value"]
    let containerVersion = "0"
    try {
        containerVersion = selectedValue === NODE_MODULE_NAME
            ? await getContainerNodeVersion(coin, network, selected["container_id"])
            : await getContainerModuleVersion(selectedValue, coin, network, selected["container_id"])
    } catch { /* not available */ }

    const moduleActions = installedModuleActions(selected["status"], selectedValue, localVersion, remoteVersion, containerVersion)
    const actionAnswer = await promptModuleAction(moduleActions)
    await runInstalledModuleAction(actionAnswer, selected, coin, network)
}

// Offers to install a module that has no container, from a local checkout if any.
async function offerMissingModule(selectedValue, localVersion, coin, network) {
    const moduleActions = []
    if (localVersion !== "0") {
        moduleActions.push({ name: "Install from local", value: "install from local" })
    } else {
        moduleActions.push({ name: "Install", value: "install" })
    }
    moduleActions.push({ name: "Return", value: "return" })

    const actionAnswer = await promptModuleAction(moduleActions)
    if (actionAnswer === "Install" || actionAnswer === "Install from local") {
        try {
            await installModules({ [coin]: { [network]: [selectedValue] } })
        } catch (err) {
            console.log(redactSecrets(err))
        }
    }
}

async function modulesSelectionInterface(coin, network) {
    const modulesStatus = await getStatus(null, null, false)
    const remoteModuleVersions = getRemoteModuleVersions()
    const { moduleChoices, actionModules } = buildModuleChoices(modulesStatus, coin, network)

    const modulesSelect = new Select({
        name: 'action',
        message: 'In which (' + coin + '/' + network + ') module do you want to perform actions?',
        choices: moduleChoices
    })

    const moduleAnswer = await modulesSelect.run().catch(() => "Return")

    if (moduleAnswer === "Return") {
        return { menuFunction: mainMenu, parameters: [] }
    } else if (moduleAnswer === "Uninstall all the modules") {
        const modulesToUninstall = Object.values(actionModules)
            .filter(mod => mod["status"] !== "missing" && mod["value"] !== DB_MODULE_NAME)
            .map(mod => mod["value"])
        try {
            await uninstallModules({ [coin]: { [network]: modulesToUninstall } })
        } catch (err) {
            console.log(redactSecrets(err))
        }
        return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
    } else if (moduleAnswer === "Install the node") {
        try {
            await installNode(coin, network)
        } catch (err) {
            console.log("There was a problem installing the node")
            console.log(redactSecrets(err))
        }
        return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
    } else if (moduleAnswer === "Perform an E2E test") {
        try {
            const { logFile, exitCode } = await runE2ETest(coin, network)
            console.log("E2E tests finished with exit code " + exitCode)
            console.log("Logs saved to: " + logFile)
        } catch (err) {
            console.log(redactSecrets(err))
        }
        return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
    } else if (moduleAnswer in actionModules) {
        const selected = actionModules[moduleAnswer]
        const { remoteVersion, localVersion } = await readModuleVersions(selected["value"], remoteModuleVersions, coin, network)

        if (selected["status"] !== "missing") {
            await manageInstalledModule(selected, coin, network, localVersion, remoteVersion)
        } else {
            await offerMissingModule(selected["value"], localVersion, coin, network)
        }
    }

    return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
}

function exit() {
    process.exit()
}

async function mainMenu() {
    const networkPrompt = new Select({
        name: "network",
        message: "Select the network",
        choices: Object.values(Network)
    })

    const modulesStatus = await getStatus(null, null, true)

    const prompt = new Select({
        name: 'action',
        message: 'Select a coin and a network to check the status and install/uninstall modules',
        choices: Object.values(Coin).concat([
            { name: 'Scan already installed modules', value: 'scan_modules' },
            { name: 'Exit', value: 'exit' }
        ])
    })

    const answer = await prompt.run().catch(() => null)

    if (answer == null || answer === "Exit") {
        console.log("Bye!")
        return { menuFunction: exit, parameters: [] }
    } else if (answer === "Scan already installed modules") {
        try {
            await scanAndRegisterModules()
            await statusChanged()
        } catch (err) {
            console.log(redactSecrets(err))
        }
        return { menuFunction: mainMenu, parameters: [] }
    } else {
        const networkAnswer = await networkPrompt.run().catch(() => null)
        if (networkAnswer == null) return { menuFunction: mainMenu, parameters: [] }
        return { menuFunction: modulesSelectionInterface, parameters: [answer, networkAnswer] }
    }
}

async function startInterface() {
    console.log("Xchain-Node ver 0.0.0")
    console.log("")

    let menuFunction = mainMenu
    let parameters = []

    while (true) {
        const result = await menuFunction(...parameters)
        menuFunction = result["menuFunction"]
        parameters = result["parameters"]
    }
}

module.exports = {
    mainMenu,
    modulesSelectionInterface,
    restoreBootstrapInterface,
    startInterface,
    // Exported so a test can assert every offered label has a handler branch.
    MODULE_ACTION_LABELS: {
        ACTION_UPDATE_LOCAL,
        ACTION_REINSTALL_REMOTE,
        ACTION_UPDATE_CONTAINER,
        ACTION_REINSTALL_CONTAINER,
        ACTION_INSTALL_LOCAL_IN_CONTAINER
    }
}
