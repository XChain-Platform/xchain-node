/*********************************************************************
 * XChain Node - Interactive UI / Menu
 ********************************************************************/

const { exec }  = require('child_process')
const { Select } = require('enquirer')
const semver    = require('semver')

const {
    NODE_MODULE_NAME, DB_MODULE_NAME, XChainService, Coin, Network, SEP
} = require('../config/constants')
const { db, getRemoteModuleVersions }   = require('../state')
const { getStatus, statusChanged }       = require('../services/StatusService')
const { cloneGit, installModule } = require('../services/ModuleService')
const { installModules, uninstallModules, updateModules, restartModules } = require('../operations/moduleOperations')
const { installNode }                    = require('../services/NodeService')
const { makeBootstrap, restoreBootstrap, getBootstrapFilesList } = require('../services/BootstrapService')
const {
    getLocalNodeVersion, getLocalModuleVersion,
    getContainerNodeVersion, getContainerModuleVersion
} = require('../services/VersionService')

async function scanModules() {
    return new Promise((resolve) => {
        exec('docker ps -a --no-trunc --format json', async (error, stdout) => {
            const { NODE_PREFIX, SEP } = require('../config/constants')
            const containers = stdout.trim()
                .split('\n').filter(line => line.trim().length > 0)
                .map(line => JSON.parse(line))

            for (const nextContainer of containers) {
                let imageName = nextContainer.Image
                if (!imageName.startsWith(NODE_PREFIX)) continue

                imageName = imageName.substr(NODE_PREFIX.length + 1)
                const parts = imageName.split(SEP)

                if (parts.length === 3) {
                    const coin = Coin[parts[0]]
                    const network = Coin[parts[1]]
                    const { stringToXChainService } = require('../utils/helpers')

                    if (coin != null && network != null) {
                        let module = stringToXChainService(parts[2])
                        if (module != null) {
                            module = XChainService[module]
                        } else if (parts[2] === NODE_MODULE_NAME) {
                            module = NODE_MODULE_NAME
                        }

                        if (module != null) {
                            const moduleDb = await db.getModuleContainer(module, coin, network)
                            if (moduleDb == null) {
                                await db.insertModuleContainer(module, coin, network, nextContainer.ID)
                                console.log("Added " + coin + "-" + network + SEP + module + " (" + nextContainer.ID + ")")
                            }
                        }
                    }
                }
            }
            resolve(true)
        })
    })
}

async function restoreBootstrapInterface(coin, network, module) {
    const bootstrapFiles = await getBootstrapFilesList(coin, network, module)
    const moduleChoices = bootstrapFiles.map(f => ({ name: f, value: f }))
    moduleChoices.push({ name: "Return", value: "return" })

    const modulesSelect = new Select({
        name: 'action',
        message: 'Which bootstrap do you want to restore?',
        choices: moduleChoices
    })

    const answer = await modulesSelect.run()
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

    const moduleAnswer = await modulesSelect.run().catch(error => {
        console.log("An error has occurred in Enquirer:", error)
    })

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
            const containerId = await installModule(XChainService.XCHAIN_E2E_TEST, coin, network, true)
            console.log("The e2e test was performed in container " + containerId)
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

            const moduleActions = []

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

            if (selectedValue !== DB_MODULE_NAME) {
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

            const actionAnswer = await actionSelect.run().catch(error => {
                console.log("An error has occurred in Enquirer:", error)
            })
            if (actionAnswer === "Uninstall") {
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
                await makeBootstrap(coin, network, selectedValue)
            } else if (actionAnswer === "Restore Bootstrap") {
                await restoreBootstrapInterface(coin, network, selectedValue)
            } else if (actionAnswer === "Reinstall from remote") {
                await updateModules({ [coin]: { [network]: [selectedValue] } })
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

            const actionAnswer = await actionSelect.run().catch(error => {
                console.log("An error has occurred in Enquirer:", error)
            })
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

    const answer = await prompt.run().catch(error => {
        console.log("An error has occurred in Enquirer:", error)
    })

    if (answer === "Exit") {
        console.log("Bye!")
        return { menuFunction: exit, parameters: [] }
    } else if (answer === "Scan already installed modules") {
        try {
            await scanModules()
        } catch (err) {
            console.log(err)
        }
        return { menuFunction: mainMenu, parameters: [] }
    } else {
        const networkAnswer = await networkPrompt.run()
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
    scanModules
}
