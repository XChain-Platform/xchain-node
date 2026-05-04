/*********************************************************************
 * XChain Node - Precheck
 * Validates environment before any command runs
 ********************************************************************/

const fs = require('fs')

const { dataDir, moduleDir, tmpDir, containersFilesDir } = require('./config/constants')
const { db, isVerbose }                = require('./state')
const { checkDockerInstalledAndReachable, createDockerNetwork } = require('./services/DockerService')
const { getDockerNetwork } = require('./services/ConfigService')
const { checkAllRemoteVersions }       = require('./services/VersionService')
const { getStatus }                    = require('./services/StatusService')
const { installHubModule, updateHub }  = require('./services/HubService')
const { updateExplorer }               = require('./services/ExplorerService')
const { buildDatabaseModule, ensureXchainNodeAccess, getDatabaseHostPort } = require('./services/DatabaseService')
const { scanAndRegisterModules }       = require('./services/DiscoveryService')

function createDirectories() {
    if (!fs.existsSync(dataDir))             fs.mkdirSync(dataDir)
    if (!fs.existsSync(moduleDir))           fs.mkdirSync(moduleDir)
    if (!fs.existsSync(tmpDir))              fs.mkdirSync(tmpDir)
    if (!fs.existsSync(containersFilesDir))  fs.mkdirSync(containersFilesDir)
}

async function preCheck(checkVersions = false) {
    try {
        if (isVerbose()) console.log("Checking if Docker is installed")
        await checkDockerInstalledAndReachable()
    } catch {
        throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
    }

    if (isVerbose()) console.log("Checking/Creating directories")
    createDirectories()

    if (isVerbose()) console.log("Checking/Installing mariadb container")
    try {
        await buildDatabaseModule("", "")
    } catch (err) {
        console.log(err)
        throw new Error("There was an error installing the mariadb container")
    }

    if (isVerbose()) console.log("Checking/Creating xchain_node access for current user")
    let dbCreds
    try {
        dbCreds = await ensureXchainNodeAccess()
    } catch (err) {
        console.log(err)
        throw new Error("There was an error creating xchain_node access")
    }

    if (isVerbose()) console.log("Opening MariaDB connection")
    try {
        const port = await getDatabaseHostPort()
        await db.createDatabase({
            host:     "127.0.0.1",
            port,
            user:     dbCreds.user,
            password: dbCreds.password,
            database: dbCreds.database
        })
    } catch (err) {
        console.log(err)
        throw new Error("Couldn't open the xchain_node MariaDB database")
    }

    try {
        const moduleCount = await db.countModules()
        if (moduleCount === 0) {
            if (isVerbose()) console.log("Modules table empty, scanning Docker for existing containers")
            await scanAndRegisterModules({ silent: !isVerbose() })
        }
    } catch (err) {
        console.log(err)
        throw new Error("There was an error during module auto-discovery")
    }
    if (checkVersions) {
        if (isVerbose()) console.log("Getting all remote project versions")
        await checkAllRemoteVersions()
    }
    if (isVerbose()) console.log("Getting modules status")
    await getStatus(null, null, false, checkVersions)

    try {
        await createDockerNetwork(getDockerNetwork("", ""))
    } catch {
        throw new Error("There was an error trying to create the base xchain network")
    }

    try {
        if (isVerbose()) console.log("Checking/Installing hub module")
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
