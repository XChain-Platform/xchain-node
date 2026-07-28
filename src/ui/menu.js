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
} = require('../config/constants')
const { db, getRemoteModuleVersions }   = require('../state')
const { getStatus, statusChanged }       = require('../services/StatusService')
const { cloneGit, installModule } = require('../services/ModuleService')
const { installModules, uninstallModules, updateModules, restartModules, logModules, runE2ETest } = require('../operations/moduleOperations')
const { installNode }                    = require('../services/NodeService')
const { makeBootstrap, restoreBootstrap, getBootstrapFilesList } = require('../services/BootstrapService')
const {
    getLocalNodeVersion, getLocalModuleVersion,
    getContainerNodeVersion, getContainerModuleVersion
} = require('../services/VersionService')
const { scanAndRegisterModules } = require('../services/DiscoveryService')

async function restoreBootstrapInterface(coin, network, module, options = {}) {
    const bootstrapFiles = await getBootstrapFilesList(coin, network, module)

    // : `bootstrap restore` used to route unconditionally into the Select
    // below. Driven from a script (or any non-TTY), enquirer renders a menu
    // nobody can answer and the command simply blocks - while HOLDING the
    // mutating-command pidfile lock, which is how one restore sat wedged for
    // 2.5h and locked out every other xchain-node command on the box.
    //
    // So resolve non-interactively whenever the caller named a file, asked for
    // --latest, or there is no TTY to prompt on. getBootstrapFilesList now
    // returns NEWEST FIRST, so [0] is genuinely the latest.
    if (bootstrapFiles.length === 0)
        throw new Error(`No bootstrap archives found for ${coin}/${network} ${module}`)

    let preselected = null
    if (options.file) {
        if (!bootstrapFiles.includes(options.file))
            throw new Error(`Bootstrap '${options.file}' not found for ${coin}/${network} ${module}. Available: ${bootstrapFiles.join(', ')}`)
        preselected = options.file
    } else if (options.latest || !process.stdin.isTTY) {
        preselected = bootstrapFiles[0]
        if (!options.latest)
            console.log(`No TTY to prompt on; restoring the newest bootstrap (${preselected}). Pass --file to choose another.`)
    }

    if (preselected) {
        const restored = await restoreBootstrap(coin, network, module, preselected)
        if (restored) return true
        throw new Error(`Bootstrap restore failed for ${coin}/${network} ${module} (${preselected})`)
    }

    const moduleChoices = bootstrapFiles.map(f => ({ name: f, value: f }))
    moduleChoices.push({ name: "Return", value: "return" })

    const modulesSelect = new Select({
        name: 'action',
        message: 'Which bootstrap do you want to restore?',
        choices: moduleChoices
    })

    const answer = await modulesSelect.run().catch(() => "Return")
    if (answer === "Return") {
        return true
    } else {
        const bootstrapRestored = await restoreBootstrap(coin, network, module, answer)
        if (bootstrapRestored) {
            return true
        } else {
            throw false
        }
    }
}

async function modulesSelectionInterface(coin, network) {
    const modulesStatus = await getStatus(null, null, false)
    const remoteModuleVersions = getRemoteModuleVersions()
    const moduleChoices = []
    const actionModules = {}

    let onlyOneModuleUsingDatabase = false

    if ((coin in modulesStatus) && (network in modulesStatus[coin])) {
        onlyOneModuleUsingDatabase = !((modulesStatus.length > 2) || (modulesStatus[coin].length > 1))

        if (("" in modulesStatus) && ("" in modulesStatus[""]) && (DB_MODULE_NAME in modulesStatus[""][""])) {
            modulesStatus[coin][network][DB_MODULE_NAME] = modulesStatus[""][""][DB_MODULE_NAME]
        }

        let allModules = Object.values(XChainService)

        const e2eIndex = allModules.indexOf(XChainService.XCHAIN_E2E_TEST)
        if (e2eIndex >= 0) allModules.splice(e2eIndex, 1)

        if (network !== Network.REGTEST) {
            const regtestIndex = allModules.indexOf(XChainService.XCHAIN_REGTEST_MINER)
            if (regtestIndex >= 0) allModules.splice(regtestIndex, 1)
        }

        allModules.push(NODE_MODULE_NAME)
        allModules.push(DB_MODULE_NAME)

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
            console.log(err)
        }
        return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
    } else if (moduleAnswer === "Install the node") {
        try {
            await installNode(coin, network)
        } catch (err) {
            console.log("There was a problem installing the node")
            console.log(err)
        }
        return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
    } else if (moduleAnswer === "Perform an E2E test") {
        try {
            const { logFile, exitCode } = await runE2ETest(coin, network)
            console.log("E2E tests finished with exit code " + exitCode)
            console.log("Logs saved to: " + logFile)
        } catch (err) {
            console.log(err)
        }
        return { menuFunction: modulesSelectionInterface, parameters: [coin, network] }
    } else if (moduleAnswer in actionModules) {
        const selected = actionModules[moduleAnswer]
        const selectedStatus = selected["status"]
        const selectedValue = selected["value"]

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

        if (selectedStatus !== "missing") {
            let containerVersion = "0"
            try {
                containerVersion = selectedValue === NODE_MODULE_NAME
                    ? await getContainerNodeVersion(coin, network, selected["container_id"])
                    : await getContainerModuleVersion(selectedValue, coin, network, selected["container_id"])
            } catch { /* not available */ }

            const moduleActions = [{ name: "Tail logs", value: "tail" }]

            if (selectedStatus === "exited") moduleActions.push({ name: "Restart", value: "restart" })

            if (semver.valid(localVersion)) {
                if (semver.valid(remoteVersion)) {
                    if (semver.gt(remoteVersion, localVersion)) {
                        moduleActions.push({ name: "Update local version", value: "update locale version" })
                    } else if (semver.eq(remoteVersion, localVersion)) {
                        moduleActions.push({ name: "Reinstall from remote", value: "reinstall from remote" })
                    }
                }
                if (semver.valid(containerVersion)) {
                    if (semver.gt(localVersion, containerVersion)) {
                        moduleActions.push({ name: "Update Container", value: "update container" })
                    } else {
                        moduleActions.push({ name: "Reinstall", value: "reinstall" })
                    }
                } else {
                    moduleActions.push({ name: "Install Local Version in Container", value: "install local version in container" })
                }
            } else if (semver.valid(remoteVersion)) {
                moduleActions.push({ name: "Update locale version", value: "update locale version" })
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

            const actionSelect = new Select({
                name: 'action',
                message: 'What do you want to do with the selected module?',
                choices: moduleActions
            })

            const actionAnswer = await actionSelect.run().catch(() => "Return")
            if (actionAnswer === "Return") {
                // ESC or Return: go back to module list
            } else if (actionAnswer === "Uninstall") {
                try {
                    await uninstallModules({ [coin]: { [network]: [selectedValue] } })
                } catch (err) {
                    console.log(err)
                }
            } else if (actionAnswer === "Restart") {
                try {
                    await restartModules({ [coin]: { [network]: [selectedValue] } })
                } catch (err) {
                    console.log(err)
                }
            } else if (actionAnswer === "Update locale version") {
                await cloneGit(selectedValue, true, false)
            } else if (actionAnswer === "Update container version" || actionAnswer === "Install Local Version in Container") {
                await installModule(selectedValue, coin, network, false, selected["container_id"])
            } else if (actionAnswer === "Make Bootstrap") {
                try {
                    await makeBootstrap(coin, network, selectedValue)
                } catch (err) {
                    // A source-health refusal  is an expected outcome here,
                    // so print the reasons and stay in the menu rather than tearing
                    // the TUI down with a stack trace.
                    if (err && err.name === 'BootstrapSourceUnhealthyError') console.log(err.message)
                    else console.log(err)
                }
            } else if (actionAnswer === "Restore Bootstrap") {
                await restoreBootstrapInterface(coin, network, selectedValue)
            } else if (actionAnswer === "Reinstall from remote") {
                await updateModules({ [coin]: { [network]: [selectedValue] } })
            } else if (actionAnswer === "Tail logs") {
                await logModules({ [coin]: { [network]: [selectedValue] } })
            }
        } else {
            const moduleActions = []
            if (localVersion !== "0") {
                moduleActions.push({ name: "Install from local", value: "install from local" })
            } else {
                moduleActions.push({ name: "Install", value: "install" })
            }
            moduleActions.push({ name: "Return", value: "return" })

            const actionSelect = new Select({
                name: 'action',
                message: 'What do you want to do with the selected module?',
                choices: moduleActions
            })

            const actionAnswer = await actionSelect.run().catch(() => "Return")
            if (actionAnswer === "Install" || actionAnswer === "Install from local") {
                try {
                    await installModules({ [coin]: { [network]: [selectedValue] } })
                } catch (err) {
                    console.log(err)
                }
            }
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
            console.log(err)
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
    startInterface
}
