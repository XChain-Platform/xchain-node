/*********************************************************************
 * XChain Node - Module Operations
 * Bulk operations over lists of modules (install, start, stop, etc.)
 ********************************************************************/

const path = require('path')
const { NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, XChainService, dataDir } = require('../config/constants')
const { db }                 = require('../state')
const { getDockerContainerImageName, filterCommandParameters, getDockerNetwork } = require('../services/ConfigService')
const { createDockerNetwork, killContainer, removeContainer, stopContainer, startContainer, restartContainer, execContainer, shellContainer, logContainer, startDockerMonitor, waitContainer, saveContainerLogs } = require('../services/DockerService')
const { buildDatabaseModule } = require('../services/DatabaseService')
const { cloneGit, installModule, uninstallModule } = require('../services/ModuleService')
const { statusChanged } = require('../services/StatusService')

async function installModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            if (nextCoin && nextNetwork) {
                await createDockerNetwork(getDockerNetwork(nextCoin, nextNetwork))
                await buildDatabaseModule(nextCoin, nextNetwork)
            }
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                await installModule(nextModule, nextCoin, nextNetwork)
            }
        }
    }
    return true
}

async function updateModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (nextModule === NODE_MODULE_NAME) {
                    await installModule(nextModule, nextCoin, nextNetwork, true, moduleContainerId)
                } else {
                    await cloneGit(nextModule, true, false)
                    await installModule(nextModule, nextCoin, nextNetwork, false, moduleContainerId)
                }
            }
        }
    }
    return true
}

async function uninstallModules(servicesList, includeShared = false) {
    const sharedModules = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME]
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (!includeShared && sharedModules.includes(nextModule)) continue
                try {
                    await uninstallModule(nextCoin, nextNetwork, nextModule)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function logModules(servicesList, follow = true) {
    const moduleContainerIds = []
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    moduleContainerIds.push({
                        name: getDockerContainerImageName(nextModule, nextCoin, nextNetwork),
                        id: containerId
                    })
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }

    if (moduleContainerIds.length > 0) {
        const moduleName = moduleContainerIds[0]["name"]
        console.log("")
        console.log("")
        console.log("####" + moduleName + " LOGS####")
        console.log("")
        await logContainer(moduleContainerIds[0]["id"], follow)
    } else {
        console.log("No service was selected")
    }
    return true
}

async function monitorModules(servicesList, follow = true) {
    const moduleContainerIds = []
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    moduleContainerIds.push({
                        name: getDockerContainerImageName(nextModule, nextCoin, nextNetwork),
                        id: containerId
                    })
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    await startDockerMonitor(moduleContainerIds, follow)
    return true
}

async function restartModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    await restartContainer(containerId)
                    await statusChanged()
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function stopModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    await stopContainer(containerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function startModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    await startContainer(containerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function execModules(servicesList, command) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    const execStdOut = await execContainer(containerId, command)
                    console.log(execStdOut)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function shellModule(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                try {
                    const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                    await shellContainer(containerId)
                    return true
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function runE2ETest(coin, network) {
    const containerId = await installModule(XChainService.XCHAIN_E2E_TEST, coin, network, true, null, true)

    console.log("Running e2e tests, please wait...")
    const exitCode = await waitContainer(containerId)

    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logFile = path.join(dataDir, 'e2e-logs', `${coin}-${network}-${timestamp}.log`)

    await saveContainerLogs(containerId, logFile)
    await removeContainer(containerId)

    return { logFile, exitCode }
}

module.exports = {
    installModules,
    updateModules,
    uninstallModules,
    logModules,
    monitorModules,
    restartModules,
    stopModules,
    startModules,
    execModules,
    shellModule,
    runE2ETest
}
