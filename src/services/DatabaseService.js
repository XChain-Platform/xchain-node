/*********************************************************************
 * XChain Node - Database Service
 * MariaDB management: build, configure users, check readiness
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const mariadb     = require('mariadb')
const { Password } = require('enquirer')

const {
    DB_MODULE_NAME, XChainService, SEP
} = require('../config/constants')
const { db, getDbRootPassword, setDbRootPassword } = require('../state')
const { sleep }                   = require('../utils/helpers')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork, getModuleDatabaseName } = require('./ConfigService')
const { getStatusFromContainer, getDockerNetworkInspect, addContainerToNetwork } = require('./DockerService')
const { statusChanged }           = require('./StatusService')
const {
    XCHAIN_NODE_DB, getOsUserDbName, generatePassword,
    hasCredentials, loadCredentials, saveCredentials
} = require('./CredentialsService')

const XCHAIN_NODE_DB_HOST = "127.0.0.1"
const XCHAIN_NODE_DB_DEFAULT_PORT = 3306

async function getDatabaseContainerId() {
    try {
        const containerName = getDockerContainerImageName(DB_MODULE_NAME, "", "")
        const { stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', containerName])
        const id = stdout.trim()
        if (/^[a-f0-9]{64}$/.test(id)) return id
        return null
    } catch {
        return null
    }
}

async function getDatabaseHostPort() {
    try {
        const containerName = getDockerContainerImageName(DB_MODULE_NAME, "", "")
        const { stdout } = await execFileAsync('docker', ['port', containerName, '3306/tcp'])
        const lines = stdout.trim().split('\n').filter(Boolean)
        for (const line of lines) {
            const match = line.match(/:(\d+)$/)
            if (match) return parseInt(match[1], 10)
        }
        return XCHAIN_NODE_DB_DEFAULT_PORT
    } catch {
        return XCHAIN_NODE_DB_DEFAULT_PORT
    }
}

async function checkIfDatabaseModuleExists(coin, network) {
    try {
        const dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) return null
        const containerStatus = await getStatusFromContainer(dbContainerId)
        if (("State" in containerStatus) && ("Status" in containerStatus["State"])) {
            return dbContainerId
        } else {
            return null
        }
    } catch {
        return null
    }
}

async function checkIfDatabaseIsReady(user, userPassword, database = null) {
    const mariadbContainerId = await getDatabaseContainerId()

    let tries = 10
    while (tries > 0) {
        try {
            const args = ['exec', '-i', mariadbContainerId, 'mariadb', '-u', user, `-p${userPassword}`]
            if (database) args.push('-D', database)
            args.push('-e', 'SELECT 1')
            await execFileAsync('docker', args)
            return true
        } catch {
            tries--
            if (tries > 0) await sleep(10000)
        }
    }
    return false
}

async function askMariadbRootPassword(coin, network) {
    const cached = getDbRootPassword()
    if (cached) return cached

    const dbContainerId = await checkIfDatabaseModuleExists(coin, network)

    while (!getDbRootPassword()) {
        const messageLine = dbContainerId
            ? 'Please, type the password for the root user of mariadb to add new users'
            : 'The password for the root user of mariadb is needed. What password do you want to set?'

        const prompt = new Password({ name: 'password', message: messageLine })

        try {
            const answer = await prompt.run()

            if (dbContainerId) {
                const { stdout } = await execFileAsync('docker', ['exec', dbContainerId, 'mariadb-admin', '-u', 'root', `-p${answer}`, 'ping'])
                if (stdout.includes('mysqld is alive')) {
                    setDbRootPassword(answer)
                    return answer
                } else {
                    console.log("Wrong password, please try again")
                }
            } else {
                setDbRootPassword(answer)
                return answer
            }
        } catch (err) {
            console.log("An error has occurred asking for database password")
            throw err
        }
    }
}

async function executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, command, commandOptions = "") {
    return new Promise((resolve, reject) => {
        const args = ['exec', '-i', mariadbContainerId, 'mariadb', '-u', 'root', `-p${mariadbRootPassword}`, '-e', command]
        if (commandOptions) {
            args.push(...commandOptions.trim().split(/\s+/))
        }

        execFile('docker', args, (error, stdout) => {
            if (error) {
                reject(error)
            } else {
                resolve(stdout.trim())
            }
        })
    })
}

async function addUserPasswordToDatabase(module, coin, network, databaseName, user, userPassword, inDocker = true) {
    const mariadbRootPassword = await askMariadbRootPassword(coin, network)
    const moduleContainerId = await db.getModuleContainer(module, coin, network)
    const dockerNetwork = getDockerNetwork(coin, network)
    const dockerNetworkInspect = await getDockerNetworkInspect(dockerNetwork)

    let gatewayIp = dockerNetworkInspect["IPAM"]["Config"][0]["Gateway"]
    const parts = gatewayIp.split(".")
    gatewayIp = parts[0] + "." + parts[1] + ".0.0"

    const host = gatewayIp + "/255.255.0.0"
    const mariadbUser = "'" + user + "'@'" + host + "'"

    if (inDocker) {
        try {
            await checkIfDatabaseIsReady("root", mariadbRootPassword)
            const mariadbContainerId = await getDatabaseContainerId()

            const dbCount = await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                "SELECT COUNT(SCHEMA_NAME) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '" + databaseName + "'", "-B -N"
            )
            if (dbCount == 0) {
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "CREATE DATABASE IF NOT EXISTS " + databaseName
                )
                console.log("Database " + databaseName + " created!")
            }

            const userCount = await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                "SELECT COUNT(*) FROM mysql.user WHERE user = '" + user + "' AND host = '" + host + "' AND password = PASSWORD('" + userPassword + "')", "-B -N"
            )
            if (userCount == 0) {
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "CREATE USER IF NOT EXISTS " + mariadbUser + " IDENTIFIED BY '" + userPassword + "'"
                )
                console.log("User " + mariadbUser + " created!")
            }

            let userGrants = await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                "SHOW GRANTS FOR " + mariadbUser, "-B -N"
            )
            userGrants = userGrants.replaceAll("`", "'").split("\n")
            if (!userGrants.includes("GRANT ALL PRIVILEGES ON '" + databaseName + "'.* TO " + mariadbUser)) {
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "GRANT ALL PRIVILEGES ON " + databaseName + ".* TO " + mariadbUser
                )
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, "FLUSH PRIVILEGES")
                console.log("Permissions granted to " + mariadbUser + "!")
            }

            return true
        } catch (err) {
            console.log(err)
            throw err
        }
    } else {
        // TODO: add user to a remote mariadb
    }
}

async function setDatabaseParameters() {
    const { getInstalledCoinsAndNetworks } = require('./StatusService')
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const dbContainerId = await getDatabaseContainerId()

    for (const nextCoin in installedCoinsAndNetworks) {
        for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
            try {
                await addContainerToNetwork(dbContainerId, getDockerNetwork(nextCoin, nextNetwork))
                await statusChanged()

                let containerId = await db.getModuleContainer(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                if (containerId) {
                    const cfg = await getDefaultConfig(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                    await addUserPasswordToDatabase(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork, cfg["DECODER_DB_NAME"], cfg["DECODER_DB_USER"], cfg["DECODER_DB_PASS"])
                }

                containerId = await db.getModuleContainer(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                if (containerId) {
                    const cfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                    await addUserPasswordToDatabase(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork, cfg["INDEXER_DB_NAME"], cfg["INDEXER_DB_USER"], cfg["INDEXER_DB_PASS"])
                    await addUserPasswordToDatabase(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork, cfg["DECODER_DB_NAME"], cfg["DECODER_DB_USER"], cfg["DECODER_DB_PASS"])
                }
            } catch (err) {
                console.log(err)
                console.log("There was a problem adding the database container to the docker network of " + nextCoin + " " + nextNetwork)
                throw err
            }
        }
    }

    return true
}

async function resetDatabases(coin, network, modules = [XChainService.XCHAIN_DECODER, XChainService.XCHAIN_INDEXER]) {
    const mariadbRootPassword = await askMariadbRootPassword(coin, network)
    const mariadbContainerId  = await getDatabaseContainerId()

    for (const module of modules) {
        const dbName = getModuleDatabaseName(module, coin, network)
        await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
            `DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE ${dbName}`
        )
        console.log(`Database ${dbName} reset!`)
    }
}

async function buildDatabaseModule(coin, network) {
    const existingId = await checkIfDatabaseModuleExists(coin, network)

    if (!existingId) {
        console.log("Installing mariadb database...")
        const mariadbRootPassword = await askMariadbRootPassword(coin, network)
        const environmentVariables = await getDefaultConfig(DB_MODULE_NAME, coin, network)
        const containerPrefix = getDockerContainerImageName(DB_MODULE_NAME, coin, network)

        console.log("Building image of database")
        await execFileAsync('docker', ['pull', 'mariadb:latest'])
        await execFileAsync('docker', ['tag', 'mariadb:latest', containerPrefix])

        const runArgs = ['run', '-d', '--name', containerPrefix, '--hostname', 'mariadb']
        if (coin !== "" && network !== "") {
            runArgs.push('--network', getDockerNetwork(coin, network))
        }
        const dbHostPort = environmentVariables["DB_PORT"] || XCHAIN_NODE_DB_DEFAULT_PORT
        runArgs.push('-p', `${XCHAIN_NODE_DB_HOST}:${dbHostPort}:3306`)
        runArgs.push('--env', `MYSQL_ROOT_PASSWORD=${mariadbRootPassword}`, containerPrefix)

        console.log("Creating container of module " + DB_MODULE_NAME)
        const { stdout } = await execFileAsync('docker', runArgs)
        const containerId = stdout.trim()
        if (/^[a-f0-9]{64}$/.test(containerId)) {
            await statusChanged()
            return containerId
        }
    } else {
        try {
            if (coin && network) {
                const dbContainerId = await getDatabaseContainerId()
                await addContainerToNetwork(dbContainerId, getDockerNetwork(coin, network))
                await statusChanged()
            }
            return true
        } catch (err) {
            console.log(err)
            throw "There was a problem trying to add the db container to the network " + coin + " " + network
        }
    }
}

async function ensureXchainNodeAccess() {
    const containerId = await getDatabaseContainerId()
    if (!containerId) {
        throw new Error("MariaDB container not found — install it before requesting access")
    }

    const existing = hasCredentials() ? loadCredentials() : null

    if (existing) {
        const works = await checkIfDatabaseIsReady(existing.user, existing.password, XCHAIN_NODE_DB)
        if (works) return existing
        console.log("Stored xchain-node credentials no longer work against this MariaDB (auth or xchain_node DB missing) — reprovisioning")
    }

    const rootPassword = await askMariadbRootPassword("", "")
    const ready = await checkIfDatabaseIsReady("root", rootPassword)
    if (!ready) {
        throw new Error("MariaDB is not responding")
    }

    const dbUser     = existing?.user     || getOsUserDbName()
    const dbPassword = existing?.password || generatePassword()

    console.log("Creating xchain-node database and user " + dbUser)
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "CREATE DATABASE IF NOT EXISTS " + XCHAIN_NODE_DB
    )
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "CREATE USER IF NOT EXISTS '" + dbUser + "'@'%' IDENTIFIED BY '" + dbPassword + "'"
    )
    // Force the password in case the user existed with a different one (stale state)
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "ALTER USER '" + dbUser + "'@'%' IDENTIFIED BY '" + dbPassword + "'"
    )
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "GRANT ALL PRIVILEGES ON " + XCHAIN_NODE_DB + ".* TO '" + dbUser + "'@'%'"
    )
    await executeDockerMariaDbCommand(containerId, rootPassword, "FLUSH PRIVILEGES")

    const creds = { user: dbUser, password: dbPassword, database: XCHAIN_NODE_DB }
    saveCredentials(creds)
    console.log("Credentials saved to user home directory")
    return creds
}

module.exports = {
    checkIfDatabaseModuleExists,
    checkIfDatabaseIsReady,
    askMariadbRootPassword,
    executeDockerMariaDbCommand,
    addUserPasswordToDatabase,
    setDatabaseParameters,
    buildDatabaseModule,
    resetDatabases,
    getDatabaseContainerId,
    getDatabaseHostPort,
    ensureXchainNodeAccess
}
