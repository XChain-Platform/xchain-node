/*********************************************************************
 * XChain Node - Database Service
 * MariaDB management: build, configure users, check readiness
 ********************************************************************/

const { exec }    = require('child_process')
const { promisify } = require('util')
const execAsync   = promisify(exec)
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

async function checkIfDatabaseModuleExists(coin, network) {
    try {
        const dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
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

async function checkIfDatabaseIsReady(user, userPassword) {
    const mariadbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
    const dockerCommand = 'docker exec -i ' + mariadbContainerId + ' mariadb -u ' + user + ' -p' + userPassword + ' -e "SELECT 1"'

    let tries = 10
    while (tries > 0) {
        try {
            await execAsync(dockerCommand)
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
    const commandLine = "docker exec " + dbContainerId + " mariadb-admin -u root -p"

    while (!getDbRootPassword()) {
        const messageLine = dbContainerId
            ? 'Please, type the password for the root user of mariadb to add new users'
            : 'The password for the root user of mariadb is needed. What password do you want to set?'

        const prompt = new Password({ name: 'password', message: messageLine })

        try {
            const answer = await prompt.run()

            if (dbContainerId) {
                const { stdout } = await execAsync(commandLine + answer + " ping")
                if (stdout.includes('mysqld is alive')) {
                    setDbRootPassword(answer)
                    return answer
                } else {
                    console.log("❌ Wrong password, please try again")
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
        let dockerCommand = 'docker exec -i ' + mariadbContainerId + ' mariadb -u root -p' + mariadbRootPassword + ' -e "' + command + '"'
        if (commandOptions !== "") dockerCommand += " " + commandOptions

        exec(dockerCommand, (error, stdout) => {
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
            const mariadbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")

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
    const dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")

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
    const mariadbContainerId  = await db.getModuleContainer(DB_MODULE_NAME, "", "")

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
        const portLine = ("DB_PORT" in environmentVariables) ? "-p " + environmentVariables["DB_PORT"] + ":3306" : ""
        const networkLine = (coin !== "" && network !== "") ? '--network ' + getDockerNetwork(coin, network) : ""

        await execAsync('docker pull mariadb:latest')
        await execAsync('docker tag mariadb:latest ' + containerPrefix)

        const dockerCommand = 'docker run -d --hostname mariadb ' + networkLine + ' ' + portLine + ' --env MYSQL_ROOT_PASSWORD=' + mariadbRootPassword + ' ' + containerPrefix
        console.log("Creating container of module " + DB_MODULE_NAME)
        const { stdout } = await execAsync(dockerCommand)
        const containerId = stdout.trim()
        if (containerId.length === 64) {
            if (await db.insertModuleContainer(DB_MODULE_NAME, "", "", containerId)) {
                await statusChanged()
                return containerId
            } else {
                throw "There was a problem trying to store the container's id"
            }
        }
    } else {
        try {
            if (coin && network) {
                const dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
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

module.exports = {
    checkIfDatabaseModuleExists,
    checkIfDatabaseIsReady,
    askMariadbRootPassword,
    executeDockerMariaDbCommand,
    addUserPasswordToDatabase,
    setDatabaseParameters,
    buildDatabaseModule,
    resetDatabases
}
