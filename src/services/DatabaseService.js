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
 * XChain Node - Database Service
 * MariaDB management: build, configure users, check readiness
 ********************************************************************/

const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const mariadb     = require('mariadb')
const { Password, Input, NumberPrompt } = require('enquirer')

const {
    DB_MODULE_NAME, HUB_MODULE_NAME, XChainService, SEP,
    EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT, EXTERNAL_DB_ROOT_USER
} = require('../config/constants')
const { db, getDbRootPassword, setDbRootPassword } = require('../state')
const { sleep }                   = require('../utils/helpers')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/dockerMariadb')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork, getModuleDatabaseName } = require('./ConfigService')
const { getStatusFromContainer, getDockerNetworkInspect, addContainerToNetwork } = require('./DockerService')
const { statusChanged }           = require('./StatusService')
const {
    XCHAIN_NODE_DB, getOsUserDbName, generatePassword,
    hasCredentials, loadCredentials, saveCredentials,
    hasExternalDbConfig, loadExternalDbConfig, saveExternalDbConfig
} = require('./CredentialsService')

const XCHAIN_NODE_DB_HOST = "127.0.0.1"
const XCHAIN_NODE_DB_DEFAULT_PORT = 13306

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

// Open the shared MariaDB connection pool if it isn't already open.
// The CLI precheck normally does this, but restore/maintenance routines can
// be invoked outside that path (e.g. driven directly rather than through the
// interactive menu), in which case `db.pool` would be null and every
// `db.getModuleContainer(...)` call would silently return null. Calling this
// first makes those routines safe regardless of how they were invoked. It is
// idempotent: a no-op once the pool is open.
async function ensureDatabasePool() {
    if (db.isReady()) return

    const dbCreds = await ensureXchainNodeAccess()
    const dbHost  = EXTERNAL_DB ? EXTERNAL_DB_HOST : XCHAIN_NODE_DB_HOST
    const dbPort  = EXTERNAL_DB ? EXTERNAL_DB_PORT : await getDatabaseHostPort()
    await db.createDatabase({
        host:     dbHost,
        port:     dbPort,
        user:     dbCreds.user,
        password: dbCreds.password,
        database: dbCreds.database
    })
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
            const args = dockerMariadbArgs(mariadbContainerId, ['mariadb', '-u', user], { interactive: true })
            if (database) args.push('-D', database)
            args.push('-e', 'SELECT 1')
            await execFileAsync('docker', args, { env: mariadbEnv(userPassword) })
            return true
        } catch {
            tries--
            if (tries > 0) await sleep(10000)
        }
    }
    return false
}

// Returns full external-DB config { host, port, root_user, root_password }.
// Precedence: env vars (all four) → credentials.json `externalDb` block →
// interactive prompt → verify → persist. Cached in state.dbRootPassword for
// the rest of the process so we don't re-prompt within a single CLI run.
async function getExternalDbConfig() {
    // Fast path: env vars supply everything for headless flows
    if (process.env.XCHAIN_NODE_EXTERNAL_DB_HOST
        && process.env.XCHAIN_NODE_EXTERNAL_DB_PORT
        && process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER
        && process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD) {
        return {
            host:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
            port:          parseInt(process.env.XCHAIN_NODE_EXTERNAL_DB_PORT, 10),
            root_user:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
            root_password: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
        }
    }

    // Saved config wins next
    if (hasExternalDbConfig()) {
        const saved = loadExternalDbConfig()
        if (saved) {
            // Verify still works; bad creds in storage mean we should re-prompt
            try {
                await _pingMariaDb(saved)
                return saved
            } catch {
                console.log("Saved external-DB credentials no longer work. Please re-enter them.")
            }
        }
    }

    // Interactive prompt
    console.log("\nExternal MariaDB configuration (XCHAIN_NODE_EXTERNAL_DB=1)")
    console.log("Provide the connection details for the host-native MariaDB this node should use.\n")

    let cfg = null
    while (!cfg) {
        const hostPrompt = new Input({ name: 'host', message: 'Host', initial: EXTERNAL_DB_HOST })
        const host = await hostPrompt.run()
        const portPrompt = new NumberPrompt({ name: 'port', message: 'Port', initial: EXTERNAL_DB_PORT })
        const port = await portPrompt.run()
        const userPrompt = new Input({ name: 'root_user', message: 'Root user', initial: EXTERNAL_DB_ROOT_USER })
        const root_user = await userPrompt.run()
        const passPrompt = new Password({ name: 'root_password', message: 'Root password' })
        const root_password = await passPrompt.run()

        const candidate = { host: String(host).trim(), port: Number(port), root_user: String(root_user).trim(), root_password }
        try {
            await _pingMariaDb(candidate)
            saveExternalDbConfig(candidate)
            console.log("External MariaDB connection verified. Saved to ~/.xchain-node/credentials.json")
            cfg = candidate
        } catch (err) {
            console.log("Could not connect: " + (err.message || err) + ". Please try again.")
        }
    }
    return cfg
}

// Lightweight ping: open a one-shot connection, SELECT 1, close.
async function _pingMariaDb({ host, port, root_user, root_password }) {
    const conn = await mariadb.createConnection({
        host, port: Number(port), user: root_user, password: root_password,
        connectTimeout: 5_000
    })
    try {
        await conn.query("SELECT 1")
    } finally {
        try { await conn.end() } catch {}
    }
}

// Execute a single SQL statement against the external (host-native) MariaDB
// as the root user. Mirrors the interface of executeDockerMariaDbCommand
// so callers can switch on EXTERNAL_DB without changing their structure.
// commandOptions is honored for "-B -N" (batch, no-headers) which existing
// callers use to parse single-value queries.
async function executeNativeMariaDbCommand(externalCfg, command, commandOptions = "") {
    const batchMode = /(^|\s)-B(\s|$)/.test(commandOptions) || /(^|\s)--batch(\s|$)/.test(commandOptions)
    const noHeaders = /(^|\s)-N(\s|$)/.test(commandOptions) || /(^|\s)--skip-column-names(\s|$)/.test(commandOptions)

    const conn = await mariadb.createConnection({
        host:          externalCfg.host,
        port:          Number(externalCfg.port),
        user:          externalCfg.root_user,
        password:      externalCfg.root_password,
        connectTimeout: 10_000,
        // Match the docker-exec contract: return rows as arrays of strings
        // when batch-mode parsing is needed, otherwise plain objects.
        rowsAsArray:   batchMode
    })
    try {
        const result = await conn.query(command)
        // For DDL/DML, result has no .length property typically; return ''.
        // For SELECTs, format to match docker-exec stdout shape.
        if (!Array.isArray(result)) return ''
        if (batchMode) {
            // Each row is an array; join columns by tab, rows by newline.
            // When -N also set, no header row is emitted (rowsAsArray already
            // omits a header from result).
            const lines = result.map(row => row.join('\t'))
            return lines.join('\n')
        }
        return ''
    } catch (err) {
        // The mariadb driver embeds the failing SQL in its error
        // (`.message` / `.sql` / `.text`). A user-creation statement carries
        // PASSWORD('<userPassword>'), so scrub the SQL out before the error
        // propagates to callers that console.log it. (The docker path keeps
        // the SQL out of argv entirely; this is the external-DB equivalent.)
        throw scrubSqlFromError(err, command)
    } finally {
        try { await conn.end() } catch {}
    }
}

// Remove a SQL statement (which may embed a secret like PASSWORD('<pw>')) from
// the common string fields of an error a caller might console.log. Mutates and
// returns the same error; tolerant of read-only fields.
function scrubSqlFromError(err, command) {
    if (!err || !command) return err
    const RED = '<redacted-sql>'
    for (const field of ['message', 'cmd', 'sql', 'sqlMessage', 'text']) {
        const value = err[field]
        if (typeof value === 'string' && value.includes(command)) {
            try { err[field] = value.split(command).join(RED) } catch { /* read-only */ }
        }
    }
    return err
}

async function askMariadbRootPassword(coin, network) {
    const cached = getDbRootPassword()
    if (cached) return cached

    // External-DB mode: defer to the full external config helper. Cache the
    // password so subsequent calls in the same process are free.
    if (EXTERNAL_DB) {
        const cfg = await getExternalDbConfig()
        setDbRootPassword(cfg.root_password)
        return cfg.root_password
    }

    if (process.env.XCHAIN_NODE_DB_ROOT_PASSWORD) {
        setDbRootPassword(process.env.XCHAIN_NODE_DB_ROOT_PASSWORD)
        return process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
    }

    const dbContainerId = await checkIfDatabaseModuleExists(coin, network)

    // If the mariadb container is already up, its MYSQL_ROOT_PASSWORD env is
    // the source of truth. Read it directly so non-interactive runs (CI, the
    // review system's release-check producer, scripted resets) don't hang on
    // a stdin prompt. Falls through to the prompt if the env isn't readable.
    if (dbContainerId) {
        try {
            const { stdout } = await execFileAsync('docker', ['exec', dbContainerId, 'printenv', 'MYSQL_ROOT_PASSWORD'])
            const fromEnv = stdout.replace(/\r?\n$/, '')
            if (fromEnv) {
                const ping = await execFileAsync('docker', dockerMariadbArgs(dbContainerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(fromEnv) })
                if (ping.stdout.includes('mysqld is alive')) {
                    setDbRootPassword(fromEnv)
                    return fromEnv
                }
            }
        } catch { /* fall through to interactive prompt */ }
    }

    while (!getDbRootPassword()) {
        const messageLine = dbContainerId
            ? 'Please, type the password for the root user of mariadb to add new users'
            : 'The password for the root user of mariadb is needed. What password do you want to set?'

        const prompt = new Password({ name: 'password', message: messageLine })

        try {
            const answer = await prompt.run()

            if (dbContainerId) {
                const { stdout } = await execFileAsync('docker', dockerMariadbArgs(dbContainerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(answer) })
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
        // The SQL is fed to the mariadb client over STDIN, never as an
        // `-e <sql>` argv entry. User-creation statements embed a secret
        // (PASSWORD('<userPassword>')), so keeping the SQL out of argv keeps it
        // out of the child's /proc/<pid>/cmdline (world-readable on the host)
        // entirely, closing the transient exposure that a `-e <sql>` argv left
        // open during the exec. The mariadb client reads statements from stdin
        // when no -e is given; `docker exec -i` (interactive) pipes our stdin
        // through to it. The root password still travels via MYSQL_PWD env (see
        // dockerMariadbArgs), never argv.
        const args = dockerMariadbArgs(mariadbContainerId, ['mariadb', '-u', 'root'], { interactive: true })
        if (commandOptions) {
            args.push(...commandOptions.trim().split(/\s+/))
        }

        const child = spawn('docker', args, { env: mariadbEnv(mariadbRootPassword) })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim())
                return
            }
            // mariadb's batch-mode error text can echo a fragment of the failing
            // statement (which may carry the embedded secret): scrub the SQL
            // before the error propagates to callers that console.log it.
            let detail = stderr.trim()
            if (command && detail) detail = detail.split(command).join('<redacted-sql>')
            const error = new Error('mariadb command failed (exit ' + code + ')' + (detail ? ': ' + detail : ''))
            error.code = code
            reject(error)
        })
        // Ignore EPIPE if the client exits before consuming all input.
        child.stdin.on('error', () => {})
        child.stdin.end(command.endsWith(';') ? command + '\n' : command + ';\n')
    })
}

async function addUserPasswordToDatabase(module, coin, network, databaseName, user, userPassword, inDocker = true) {
    const mariadbRootPassword = await askMariadbRootPassword(coin, network)
    const moduleContainerId = await db.getModuleContainer(module, coin, network)

    // Host is '%' so cross-network shared services (xchain-explorer, xchain-hub)
    // can authenticate against per-coin indexer/decoder DBs. Earlier code derived
    // a per-coin subnet from the docker network gateway, which blocked the
    // explorer (172.18.x) from reaching e.g. xchain_indexer_litecoin_regtest
    // (granted only from 172.20.0.0/16). MariaDB is on private docker networks
    // and never bound to the host, so '%' here doesn't broaden external exposure.
    const host = "%"
    const mariadbUser = "'" + user + "'@'" + host + "'"

    // EXTERNAL_DB short-circuits the inDocker branch: even if a caller passed
    // inDocker=true (today's default for backward compat), we route through
    // the native MariaDB path. Single switch, no caller changes required.
    const useDocker = inDocker && !EXTERNAL_DB

    if (useDocker) {
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
                // Force the password in case the user already existed with a different one:
                // userCount==0 also covers "user exists but password mismatches", and
                // CREATE USER IF NOT EXISTS is a silent no-op for an existing user. This
                // ALTER (mirroring the external-DB path below) is what rotates an existing
                // install from the legacy static password to the generated per-install one
                // on the next update.
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "ALTER USER " + mariadbUser + " IDENTIFIED BY '" + userPassword + "'"
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

            // The e2e federation suites (xchain-e2e-test test:federation /
            // test:attestation:llm) spin up throwaway in-process validator hubs
            // via MultiValidatorHub, each creating + dropping its own DB named
            // XChain_<coin>_<network>_MVH_<pid>_<n>. Grant the hub user CREATE/DROP
            // on ONLY that test-only name pattern (escaped underscores → matches
            // nothing but MVH databases) so those suites run without a privileged
            // root account. Idempotent; harmless on networks that never run them.
            if (module === HUB_MODULE_NAME) {
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "GRANT ALL PRIVILEGES ON `XChain\\_%\\_MVH\\_%`.* TO " + mariadbUser
                )
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, "FLUSH PRIVILEGES")
                console.log("MVH test-database permissions granted to " + mariadbUser + "!")
            }

            return true
        } catch (err) {
            console.log(err)
            throw err
        }
    } else {
        // External (host-native) MariaDB path. Same DDL as the docker branch
        // above, just sent over the network to the configured host instead
        // of via `docker exec`. EXTERNAL_DB config is loaded fresh here so
        // callers don't have to thread it through the parameter list.
        const externalCfg = await getExternalDbConfig()
        try {
            const dbCount = await executeNativeMariaDbCommand(externalCfg,
                "SELECT COUNT(SCHEMA_NAME) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '" + databaseName + "'", "-B -N"
            )
            if (dbCount == 0) {
                await executeNativeMariaDbCommand(externalCfg,
                    "CREATE DATABASE IF NOT EXISTS " + databaseName
                )
                console.log("Database " + databaseName + " created!")
            }

            const userCount = await executeNativeMariaDbCommand(externalCfg,
                "SELECT COUNT(*) FROM mysql.user WHERE user = '" + user + "' AND host = '" + host + "' AND password = PASSWORD('" + userPassword + "')", "-B -N"
            )
            if (userCount == 0) {
                await executeNativeMariaDbCommand(externalCfg,
                    "CREATE USER IF NOT EXISTS " + mariadbUser + " IDENTIFIED BY '" + userPassword + "'"
                )
                // Force password in case the user already existed with a different one
                await executeNativeMariaDbCommand(externalCfg,
                    "ALTER USER " + mariadbUser + " IDENTIFIED BY '" + userPassword + "'"
                )
                console.log("User " + mariadbUser + " created!")
            }

            let userGrants = await executeNativeMariaDbCommand(externalCfg,
                "SHOW GRANTS FOR " + mariadbUser, "-B -N"
            )
            userGrants = userGrants.replaceAll("`", "'").split("\n")
            if (!userGrants.includes("GRANT ALL PRIVILEGES ON '" + databaseName + "'.* TO " + mariadbUser)) {
                await executeNativeMariaDbCommand(externalCfg,
                    "GRANT ALL PRIVILEGES ON " + databaseName + ".* TO " + mariadbUser
                )
                await executeNativeMariaDbCommand(externalCfg, "FLUSH PRIVILEGES")
                console.log("Permissions granted to " + mariadbUser + "!")
            }

            // See the docker branch above: grant the hub user CREATE/DROP on the
            // MVH test-database name pattern so the e2e federation suites run
            // without root. Test-only pattern; idempotent.
            if (module === HUB_MODULE_NAME) {
                await executeNativeMariaDbCommand(externalCfg,
                    "GRANT ALL PRIVILEGES ON `XChain\\_%\\_MVH\\_%`.* TO " + mariadbUser
                )
                await executeNativeMariaDbCommand(externalCfg, "FLUSH PRIVILEGES")
                console.log("MVH test-database permissions granted to " + mariadbUser + "!")
            }
            return true
        } catch (err) {
            console.log(err)
            throw err
        }
    }
}

async function setDatabaseParameters() {
    const { getInstalledCoinsAndNetworks } = require('./StatusService')
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const dbContainerId = EXTERNAL_DB ? null : await getDatabaseContainerId()

    for (const nextCoin in installedCoinsAndNetworks) {
        for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
            try {
                // External DB has no container to attach to per-coin networks;
                // it's reachable via the bridge gateway from inside containers.
                if (!EXTERNAL_DB) {
                    await addContainerToNetwork(dbContainerId, getDockerNetwork(nextCoin, nextNetwork))
                }
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
    // External (host-native) MariaDB: there is no database container to exec
    // into it (`docker exec ... null` failed here and aborted the reset mid-way,
    // leaving data wiped, DBs stale, services stopped). Use the driver-based
    // helper instead. DROP and CREATE go as separate statements: unlike the
    // mariadb CLI, the driver rejects multi-statement strings.
    if (EXTERNAL_DB) {
        const cfg = await getExternalDbConfig()
        for (const module of modules) {
            const dbName = getModuleDatabaseName(module, coin, network)
            await executeNativeMariaDbCommand(cfg, `DROP DATABASE IF EXISTS ${dbName}`)
            await executeNativeMariaDbCommand(cfg, `CREATE DATABASE ${dbName}`)
            console.log(`Database ${dbName} reset!`)
        }
        return
    }

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
    // External (host-native) MariaDB mode: xchain-node doesn't own the DB
    // engine; the operator runs MariaDB themselves. We just need to confirm the
    // configured external host is reachable and credentials work, then skip
    // everything else. All downstream callers (precheck, ModuleService,
    // moduleOperations, NodeService) are happy with this no-op return.
    if (EXTERNAL_DB) {
        const cfg = await getExternalDbConfig()
        try {
            await _pingMariaDb(cfg)
        } catch (err) {
            throw new Error("Cannot reach external MariaDB at " + cfg.host + ":" + cfg.port + ": " + (err.message || err))
        }
        return true
    }

    const existingId = await checkIfDatabaseModuleExists(coin, network)

    if (!existingId) {
        console.log("Installing mariadb database...")
        const mariadbRootPassword = await askMariadbRootPassword(coin, network)
        const environmentVariables = await getDefaultConfig(DB_MODULE_NAME, coin, network)
        const containerPrefix = getDockerContainerImageName(DB_MODULE_NAME, coin, network)

        console.log("Building image of database")
        await execFileAsync('docker', ['pull', 'mariadb:10.11'])
        await execFileAsync('docker', ['tag', 'mariadb:10.11', containerPrefix])

        const runArgs = ['run', '-d', '--restart', 'unless-stopped', '--name', containerPrefix, '--hostname', 'mariadb']
        runArgs.push('--network', getDockerNetwork(coin, network))
        const dbHostPort = environmentVariables["DB_PORT"] || XCHAIN_NODE_DB_DEFAULT_PORT
        runArgs.push('-p', `${XCHAIN_NODE_DB_HOST}:${dbHostPort}:3306`)
        // Optional: pin the MariaDB datadir to a host path (e.g. a fast NVMe
        // mount) instead of the image's default anonymous volume, which lands
        // under Docker's data-root (often a bulk/HDD disk). Unset = unchanged
        // behaviour. Set XCHAIN_NODE_DB_DATA_DIR=/var/lib/mysql to keep the DB
        // on a dedicated NVMe volume.
        if (process.env.XCHAIN_NODE_DB_DATA_DIR) {
            runArgs.push('-v', `${process.env.XCHAIN_NODE_DB_DATA_DIR}:/var/lib/mysql`)
        }
        // Pass the root password through docker's OWN environment via a bare
        // `--env NAME` (value supplied in the execFile env below), NOT
        // `--env NAME=value` in argv. Otherwise the secret lands in the child
        // process command line, and a failed `docker run` rejects with it
        // embedded in err.cmd/err.message, which upstream error logging
        // (e.g. precheck's console.log(err)) would print. Mirrors the
        // mariadbEnv() MYSQL_PWD pattern used on the client path.
        runArgs.push('--env', 'MYSQL_ROOT_PASSWORD', containerPrefix)

        // Optional MariaDB server tuning. These land as mysqld CLI args; the
        // mariadb image forwards any leading-dash args placed after the image
        // straight to mysqld, so they persist across a container *recreate*,
        // unlike a conf.d file written into a running container (its /etc isn't
        // a mounted volume, so a recreate drops it). Each is unset by default,
        // leaving image defaults unchanged. Size them to the host: a busy
        // multi-replica box (e.g. origin-host serving xchain-sync replicas across
        // 18 DBs) wants a large buffer pool + a higher connection ceiling and
        // can relax durable-log flushing; a laptop or single-chain node should
        // leave them off. Args go after `containerPrefix` so Docker treats them
        // as the container command, not as `docker run` options.
        const dbTuningArgs = {
            XCHAIN_NODE_DB_BUFFER_POOL_SIZE:        'innodb-buffer-pool-size',        // e.g. 16G
            XCHAIN_NODE_DB_MAX_CONNECTIONS:         'max-connections',               // e.g. 300
            XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT: 'innodb-flush-log-at-trx-commit' // e.g. 2 (faster, less durable)
        }
        for (const [envVar, mysqldFlag] of Object.entries(dbTuningArgs)) {
            const value = process.env[envVar]
            if (value) runArgs.push(`--${mysqldFlag}=${value}`)
        }

        // Pre-flight host-port collision check (multi-stack hosts): same
        // guard the service-install path uses in ModuleService.buildAndUp. Two
        // different-NODE_PREFIX stacks on one host both try to bind the DB host
        // port; without this, `docker run` fails with a cryptic "port is already
        // allocated". Lazy require avoids a load-time cycle (ModuleService
        // requires this module at top).
        const { assertNoHostPortConflicts } = require('./ModuleService')
        await assertNoHostPortConflicts(['-p', `${XCHAIN_NODE_DB_HOST}:${dbHostPort}:3306`], containerPrefix)

        console.log("Creating container of module " + DB_MODULE_NAME)
        const { stdout } = await execFileAsync('docker', runArgs, {
            env: { ...process.env, MYSQL_ROOT_PASSWORD: mariadbRootPassword }
        })
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
    const existing = hasCredentials() ? loadCredentials() : null

    if (EXTERNAL_DB) {
        const externalCfg = await getExternalDbConfig()

        // If existing creds work against the external DB, reuse them.
        if (existing) {
            try {
                const conn = await mariadb.createConnection({
                    host: externalCfg.host, port: Number(externalCfg.port),
                    user: existing.user, password: existing.password, database: XCHAIN_NODE_DB,
                    connectTimeout: 5_000
                })
                await conn.query("SELECT 1")
                await conn.end()
                return existing
            } catch {
                console.log("Stored xchain-node credentials no longer work against the external MariaDB; reprovisioning")
            }
        }

        const dbUser     = existing?.user     || getOsUserDbName()
        const dbPassword = existing?.password || generatePassword()

        console.log("Creating xchain-node database and user " + dbUser + " on external MariaDB")
        await executeNativeMariaDbCommand(externalCfg, "CREATE DATABASE IF NOT EXISTS " + XCHAIN_NODE_DB)
        await executeNativeMariaDbCommand(externalCfg, "CREATE USER IF NOT EXISTS '" + dbUser + "'@'%' IDENTIFIED BY '" + dbPassword + "'")
        // Force password in case user exists from earlier with a different one
        await executeNativeMariaDbCommand(externalCfg, "ALTER USER '" + dbUser + "'@'%' IDENTIFIED BY '" + dbPassword + "'")
        await executeNativeMariaDbCommand(externalCfg, "GRANT ALL PRIVILEGES ON " + XCHAIN_NODE_DB + ".* TO '" + dbUser + "'@'%'")
        await executeNativeMariaDbCommand(externalCfg, "FLUSH PRIVILEGES")

        const creds = { user: dbUser, password: dbPassword, database: XCHAIN_NODE_DB }
        saveCredentials(creds)
        console.log("Credentials saved to user home directory")
        return creds
    }

    const containerId = await getDatabaseContainerId()
    if (!containerId) {
        throw new Error("MariaDB container not found; install it before requesting access")
    }

    if (existing) {
        const works = await checkIfDatabaseIsReady(existing.user, existing.password, XCHAIN_NODE_DB)
        if (works) return existing
        console.log("Stored xchain-node credentials no longer work against this MariaDB (auth or xchain_node DB missing); reprovisioning")
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
    executeNativeMariaDbCommand,
    getExternalDbConfig,
    addUserPasswordToDatabase,
    setDatabaseParameters,
    buildDatabaseModule,
    resetDatabases,
    getDatabaseContainerId,
    getDatabaseHostPort,
    ensureDatabasePool,
    ensureXchainNodeAccess
}
