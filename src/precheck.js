/*********************************************************************
 * XChain Node - Precheck
 * Validates environment before any command runs
 ********************************************************************/

const fs = require('fs')

const { dataDir, moduleDir, tmpDir, containersFilesDir } = require('./config/constants')
const { db }                           = require('./state')
const { checkDockerInstalledAndReachable, createDockerNetwork } = require('./services/DockerService')
const { getDockerNetwork } = require('./services/ConfigService')
const { checkAllRemoteVersions }       = require('./services/VersionService')
const { getStatus }                    = require('./services/StatusService')
const { installHubModule, updateHub }  = require('./services/HubService')
const { updateExplorer }               = require('./services/ExplorerService')

function createDirectories() {
    if (!fs.existsSync(dataDir))             fs.mkdirSync(dataDir)
    if (!fs.existsSync(moduleDir))           fs.mkdirSync(moduleDir)
    if (!fs.existsSync(tmpDir))              fs.mkdirSync(tmpDir)
    if (!fs.existsSync(containersFilesDir))  fs.mkdirSync(containersFilesDir)
}

async function preCheck(checkVersions = false) {
    try {
        console.log("Checking if Docker is installed")
        await checkDockerInstalledAndReachable()
    } catch {
        throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
    }

    console.log("Checking/Creating directories")
    createDirectories()
    console.log("Checking/Creating database")
    await db.createDatabase()
    if (checkVersions) {
        console.log("Getting all remote project versions")
        await checkAllRemoteVersions()
    }
    console.log("Getting modules status")
    await getStatus(null, null, false)

    try {
        await createDockerNetwork(getDockerNetwork("", ""))
    } catch {
        throw new Error("There was an error trying to create the base xchain network")
    }

    try {
        console.log("Checking/Installing hub module")
        await installHubModule()
    } catch {
        throw new Error("There was an error trying to install the hub module")
    }

    try {
        await updateHub()
        await updateExplorer()
    } catch (err) {
        console.log(err)
        throw new Error("There was an error trying to update the hub module")
    }

    return true
}

module.exports = { preCheck, createDirectories }
