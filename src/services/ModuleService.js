/*********************************************************************
 * XChain Node - Module Service
 * Clone, build, install and uninstall XChain modules
 ********************************************************************/

const { exec }  = require('child_process')
const fs        = require('fs')

const {
    NODE_MODULE_NAME, DB_MODULE_NAME, EXPLORER_MODULE_NAME,
    XChainService, SEP, modulesUrls
} = require('../config/constants')
const { db }                = require('../state')
const {
    getModuleDir, getModuleTmpDir, moduleDirExists, checkIfModuleExists,
    removeModuleDir, removeModuleTmpDir, createModuleTmpDir,
    getDockerContainerImageName, getDockerNetwork, getDefaultConfig
} = require('./ConfigService')
const { statusChanged, getStatus } = require('./StatusService')
const { killContainer, removeContainer } = require('./DockerService')
const { setDatabaseParameters }  = require('./DatabaseService')

async function cloneGit(module, rewrite = false, useTmp = false) {
    return new Promise((resolve, reject) => {
        if (useTmp) {
            removeModuleTmpDir(module)
            createModuleTmpDir(module)
        } else {
            if (moduleDirExists(module)) {
                if (rewrite) {
                    removeModuleDir(module)
                } else {
                    reject("Module directory already exists")
                    return
                }
            }
        }

        if (!(module in modulesUrls)) {
            reject("module doesn't have an url")
            return
        }

        const gitUrl = modulesUrls[module]
        const destination = useTmp ? getModuleTmpDir(module) : getModuleDir(module)

        exec(`git clone ${gitUrl} ${destination}`, (error) => {
            if (error) {
                reject("Error cloning project: " + error.message)
            } else {
                resolve(true)
            }
        })
    })
}

async function buildAndUp(module, coin, network, overwriteContainerId = null, onlyExecution = false) {
    if (!checkIfModuleExists(module)) {
        throw "module not found"
    }

    const environmentVariables = await getDefaultConfig(module, coin, network)

    return new Promise((resolve, reject) => {
        let environmentVariablesLine = ""
        for (const key in environmentVariables) {
            environmentVariablesLine += ' -e "' + key + '=' + environmentVariables[key] + '"'
        }

        const dir = getModuleDir(module)
        const containerPrefix = getDockerContainerImageName(module, coin, network)

        console.log("Building image of module " + module + (coin && network ? " in " + coin + " " + network : ""))
        exec('docker build . -t ' + containerPrefix, { cwd: dir }, async (error) => {
            if (error) {
                console.error("Error creating Docker image: " + error.message)
                return
            }

            try {
                let portLine = ""
                let volumeLine = ""
                let ulimitLine = ""

                switch (module) {
                    case XChainService.XCHAIN_DECODER:
                        if ("DECODER_PORT" in environmentVariables && "DECODER_API_PORT" in environmentVariables) {
                            portLine = "-p " + environmentVariables["DECODER_PORT"] + ":" + environmentVariables["DECODER_API_PORT"]
                        }
                        volumeLine = "-v " + environmentVariables["DECODER_BOOTSTRAP_VOLUME"] + ":/bootstrap/xchain-decoder "
                        break
                    case XChainService.XCHAIN_ENCODER:
                        if ("ENCODER_PORT" in environmentVariables && "ENCODER_API_PORT" in environmentVariables) {
                            portLine = "-p " + environmentVariables["ENCODER_PORT"] + ":" + environmentVariables["ENCODER_API_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_UTXO_TRACKER:
                        if ("UTXO_TRACKER_PORT" in environmentVariables && "UTXO_TRACKER_API_PORT" in environmentVariables) {
                            portLine = "-p " + environmentVariables["UTXO_TRACKER_PORT"] + ":" + environmentVariables["UTXO_TRACKER_API_PORT"]
                        }
                        volumeLine = "-v " + module + SEP + coin + "-" + network + "-data:/data/xchain-utxo-tracker "
                            + "-v " + environmentVariables["UTXO_TRACKER_BOOTSTRAP_VOLUME"] + ":/bootstrap/xchain-utxo-tracker "
                        ulimitLine = "--ulimit nofile=2048:2048 "
                        break
                    case XChainService.XCHAIN_INDEXER:
                        if ("INDEXER_PORT" in environmentVariables && "INDEXER_API_PORT" in environmentVariables) {
                            portLine = "-p " + environmentVariables["INDEXER_PORT"] + ":" + environmentVariables["INDEXER_API_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_REGTEST_MINER:
                        if ("REGTEST_MINER_PORT" in environmentVariables) {
                            portLine = "-p " + environmentVariables["REGTEST_MINER_PORT"] + ":" + environmentVariables["REGTEST_MINER_API_PORT"]
                        }
                        break
                    case 'xchain-hub':
                        coin = ""
                        network = ""
                        portLine = "-p " + environmentVariables["HUB_PORT"] + ":" + environmentVariables["HUB_PORT"]
                        break
                    case EXPLORER_MODULE_NAME:
                        coin = ""
                        network = ""
                        portLine = "-p " + environmentVariables["EXPLORER_PORT_HTTP"] + ":" + environmentVariables["EXPLORER_API_PORT_HTTP"]
                            + " -p " + environmentVariables["EXPLORER_PORT_HTTPS"] + ":" + environmentVariables["EXPLORER_API_PORT_HTTPS"]
                        break
                }

                if (overwriteContainerId) {
                    try {
                        await killContainer(overwriteContainerId)
                    } catch { /* container may not be running */ }
                    await removeContainer(overwriteContainerId)
                }

                const dockerCommand = 'docker run '
                    + '-d --hostname ' + containerPrefix + ' '
                    + volumeLine
                    + ulimitLine
                    + '--network ' + getDockerNetwork(coin, network) + ' '
                    + environmentVariablesLine + ' '
                    + portLine + ' '
                    + '-t ' + containerPrefix

                console.log("Creating container of module " + module + (coin && network ? " in " + coin + " " + network : ""))
                exec(dockerCommand, { cwd: dir }, async (error2, stdout) => {
                    if (error2) {
                        reject("Error creating the container: " + error2.message)
                        return
                    }
                    try {
                        const containerId = stdout.trim()
                        if (containerId.length === 64) {
                            if (!onlyExecution) {
                                if (await db.insertModuleContainer(module, coin, network, containerId)) {
                                    await statusChanged()
                                    resolve(containerId)
                                } else {
                                    reject("There was a problem trying to store the container's id")
                                }
                            } else {
                                resolve(containerId)
                            }
                        }
                    } catch (err) {
                        reject(err)
                    }
                })
            } catch (err) {
                reject(err)
            }
        })
    })
}

async function installModule(module, coin, network, remoteUpdate = false, overwriteContainerId = null, onlyExecution = false) {
    if (coin === "") coin = null
    if (network === "") network = null

    const { getLocalNodeVersion, getLocalModuleVersion } = require('./VersionService')
    const { getRemoteModuleVersions, getLastStatus }     = require('../state')
    const { buildCryptoNode, getCryptoNode }             = require('./NodeService')
    const { buildDatabaseModule }                        = require('./DatabaseService')
    const { installExplorerModule }                      = require('./ExplorerService')
    const { checkRemoteNodeVersion }                     = require('./VersionService')

    if (module === NODE_MODULE_NAME) {
        const lastStatus = getLastStatus()
        const containerNodeVersion = lastStatus?.coin?.network?.module?.["container_version"] ?? null

        if (!containerNodeVersion || remoteUpdate) {
            let localNodeVersion = null
            try {
                localNodeVersion = await getLocalNodeVersion(coin, network)
            } catch { /* not installed yet */ }

            if (localNodeVersion == null || remoteUpdate) {
                try {
                    const remoteVersions = getRemoteModuleVersions()
                    if (!(NODE_MODULE_NAME + SEP + coin in remoteVersions)) {
                        await checkRemoteNodeVersion(coin)
                    }
                    const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
                    await getCryptoNode(coin, network, remoteNodeVersion)
                } catch (err) {
                    throw err
                }
            }

            await buildCryptoNode(coin, network)
            await statusChanged()
            return true
        } else {
            return false
        }
    } else if (module === DB_MODULE_NAME) {
        try {
            await buildDatabaseModule(coin, network)
            await statusChanged()
            return true
        } catch (err) {
            throw err
        }
    } else if (module === EXPLORER_MODULE_NAME) {
        try {
            await installExplorerModule()
            await statusChanged()
            return true
        } catch (err) {
            throw err
        }
    } else {
        const lastStatus = getLastStatus()
        const containerNodeVersion = lastStatus?.coin?.network?.module?.["container_version"] ?? null

        if (!containerNodeVersion || remoteUpdate) {
            let localModuleVersion = null
            try {
                localModuleVersion = await getLocalModuleVersion(module)
            } catch { /* not installed yet */ }

            try {
                if (remoteUpdate || localModuleVersion == null) {
                    await cloneGit(module, true)
                }
                const containerId = await buildAndUp(module, coin, network, overwriteContainerId, onlyExecution)
                if (module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) {
                    await setDatabaseParameters()
                }
                if (!onlyExecution) await statusChanged()
                return containerId
            } catch (err) {
                throw err
            }
        } else {
            return false
        }
    }
}

async function uninstallModule(coin, network, module) {
    const { DB_MODULE_NAME } = require('../config/constants')
    const modulesStatus = await getStatus(null, null, false)

    if (module === DB_MODULE_NAME) {
        throw "The database must be manually removed"
    }

    const moduleStatus = modulesStatus?.[(coin ?? "")]?.[(network ?? "")]?.[module]
    if (moduleStatus !== undefined) {
        console.log("Uninstalling " + module + " (" + coin + "/" + network + ")")
        try {
            if (moduleStatus["status"]["State"]["Status"] !== "exited") {
                await killContainer(moduleStatus["container_id"])
            }
            await removeContainer(moduleStatus["container_id"])
            await statusChanged()
            const removed = await db.removeModuleContainer(module, coin, network)
            if (removed) {
                return removed
            } else {
                throw "There was a problem trying to remove a container from the database"
            }
        } catch {
            throw "There was a problem trying to kill a container"
        }
    } else {
        return true
    }
}

module.exports = {
    cloneGit,
    buildAndUp,
    installModule,
    uninstallModule
}
