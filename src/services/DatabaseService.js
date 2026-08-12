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
    DB_MODULE_NAME, HUB_MODULE_NAME, XChainService, SEP, CoinTickerSymbol,
    EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT, EXTERNAL_DB_ROOT_USER
} = require('../config/constants')
const { db, getDbRootPassword, setDbRootPassword } = require('../state')
const { sleep }                   = require('../utils/helpers')
const { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../utils/sqlSafety')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/dockerMariadb')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork, getModuleDatabaseName, validatePort } = require('./ConfigService')
const { getStatusFromContainer, getDockerNetworkInspect, addContainerToNetwork, forceRemoveContainerByName } = require('./DockerService')
const { assertNoDbCredentialDrift, isDbCredentialDriftError } = require('./DbCredentialDrift')
const { statusChanged }           = require('./StatusService')
const {
    XCHAIN_NODE_DB, getOsUserDbName, generatePassword,
    hasCredentials, loadCredentials, saveCredentials,
    hasExternalDbConfig, loadExternalDbConfig, saveExternalDbConfig,
    loadDbRootPassword, saveDbRootPassword
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
    // External mode: resolve host/port from getExternalDbConfig() (env →
    // saved credentials.json → prompt), not the load-time EXTERNAL_DB_HOST/PORT
    // constants, which only reflect env vars or the 127.0.0.1:3306 defaults. A
    // host/port the operator saved at the first-run prompt would otherwise be
    // ignored and the pool would open against the wrong server (uuid:52c5b5f1).
    let dbHost, dbPort
    if (EXTERNAL_DB) {
        const extCfg = await getExternalDbConfig()
        dbHost = extCfg.host
        dbPort = extCfg.port
    } else {
        dbHost = XCHAIN_NODE_DB_HOST
        dbPort = await getDatabaseHostPort()
    }
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
// Parse + validate an external-DB port at the single resolver chokepoint. Every
// other operator/config-supplied port is validatePort-gated before it reaches a
// child process (DB_PORT here, NODE_*_PORT in NodeService, the portArgs loop in
// ModuleService); the external-DB port was the one that escaped. A malformed
// value would otherwise propagate as NaN/0/70000 into spawn('mariadb'/'mariadb-
// dump', '-P', ...) and be baked into every provisioned container's DECODER_/
// INDEXER_/HUB_DB_PORT env via the ConfigService EXTERNAL_DB rewrite, surfacing
// far from its cause as an opaque driver error. Fail loud at config resolution.
function resolveExternalDbPort(raw) {
    const port = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    if (!validatePort(port)) {
        throw new Error('Invalid external-DB port: ' + String(raw)
            + ' (set XCHAIN_NODE_EXTERNAL_DB_PORT to an integer 1-65535)')
    }
    return port
}

async function getExternalDbConfig() {
    // Fast path: env vars supply everything for headless flows
    if (process.env.XCHAIN_NODE_EXTERNAL_DB_HOST
        && process.env.XCHAIN_NODE_EXTERNAL_DB_PORT
        && process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER
        && process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD) {
        return {
            host:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
            port:          resolveExternalDbPort(process.env.XCHAIN_NODE_EXTERNAL_DB_PORT),
            root_user:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
            root_password: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
        }
    }

    // Saved config wins next
    if (hasExternalDbConfig()) {
        const saved = loadExternalDbConfig()
        if (saved) {
            // Verify still works; bad creds (or an out-of-range persisted port)
            // mean we should re-prompt rather than propagate a bad value.
            try {
                saved.port = resolveExternalDbPort(saved.port)
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

        try {
            const candidate = { host: String(host).trim(), port: resolveExternalDbPort(port), root_user: String(root_user).trim(), root_password }
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

    const dbContainerId = await checkIfDatabaseModuleExists(coin, network)

    if (process.env.XCHAIN_NODE_DB_ROOT_PASSWORD) {
        const envPassword = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
        if (!dbContainerId) {
            // No running container to verify against yet (fresh install): the
            // env override becomes the password the container is created with,
            // so there is nothing to ping. Accept as-is, same as before.
            setDbRootPassword(envPassword)
            saveDbRootPassword(envPassword)
            return envPassword
        }
        // A container is already up; its MYSQL_ROOT_PASSWORD is the source of
        // truth (see below). Verify the override actually works before
        // caching it, instead of accepting an unverified value that could
        // later burn ~100s of silent retries in checkIfDatabaseIsReady with no
        // indication the root password was the problem (uuid:2c5ec698).
        try {
            const ping = await execFileAsync('docker', dockerMariadbArgs(dbContainerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(envPassword) })
            if (ping.stdout.includes('mysqld is alive')) {
                setDbRootPassword(envPassword)
                saveDbRootPassword(envPassword)
                return envPassword
            }
        } catch { /* fall through to the container-env read / prompt below */ }
    }

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
                    saveDbRootPassword(fromEnv)
                    return fromEnv
                }
            }
        } catch { /* fall through to the credentials-store read / prompt below */ }
    }

    // Last non-interactive source: the copy persisted to credentials.json the
    // last time a root password was accepted. Covers installs whose DB
    // container carries no MYSQL_ROOT_PASSWORD env (created before the
    // env-injection path), where the printenv read above has nothing to find.
    // Verified with a ping before trusting, same as the env override; only
    // consulted when a container exists to verify against, so a stale copy
    // can never silently become a fresh install's root password.
    if (dbContainerId) {
        const stored = loadDbRootPassword()
        if (stored) {
            try {
                const ping = await execFileAsync('docker', dockerMariadbArgs(dbContainerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(stored) })
                if (ping.stdout.includes('mysqld is alive')) {
                    setDbRootPassword(stored)
                    return stored
                }
            } catch { /* stale copy; fall through to the prompt */ }
        }
    }

    // Non-interactive run (cron, ssh BatchMode, CI): enquirer's prompt would
    // block forever on a stdin that never answers (observed as a multi-hour
    // hang on a scripted `update`). Fail fast with the ways to supply the
    // password instead.
    if (!process.stdin.isTTY) {
        throw new Error(
            'MariaDB root password required but no TTY to prompt on. Supply it ' +
            'non-interactively via the XCHAIN_NODE_DB_ROOT_PASSWORD env var, or ' +
            'run any xchain-node command once interactively so the accepted ' +
            'password is persisted to credentials.json for future runs.'
        )
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
                    saveDbRootPassword(answer)
                    return answer
                } else {
                    console.log("Wrong password, please try again")
                }
            } else {
                setDbRootPassword(answer)
                saveDbRootPassword(answer)
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
    // Provisioning DDL (CREATE USER / CREATE DATABASE / GRANT) cannot bind
    // identifiers as parameters, and the docker-exec path pipes raw SQL text, so
    // these statements are built by concatenation. Gate the config-supplied
    // database name and account user through a strict [A-Za-z0-9_]+ allowlist
    // before they touch any SQL string; the password is the only value that may
    // carry arbitrary bytes and is escaped as a literal at each use site below.
    assertSafeDbIdentifier(databaseName, 'database name')
    assertSafeDbIdentifier(user, 'database user')
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
            // Fail fast when the DB container is missing or not ready, instead of
            // burning ~100s of silent readiness retries and then issuing docker
            // exec against a null container id with an opaque "mariadb command
            // failed" error. getDatabaseContainerId() returns null when no MariaDB
            // container exists at all (e.g. a fresh box), so check it first.
            const preCheckContainerId = await getDatabaseContainerId()
            if (!preCheckContainerId) {
                throw new Error("MariaDB container not found; install the database first")
            }
            const ready = await checkIfDatabaseIsReady("root", mariadbRootPassword)
            if (!ready) {
                throw new Error("MariaDB is not ready after waiting; check the database container logs")
            }
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

            // Ensure the account exists and force its password to the intended value on every
            // run. The previous COUNT(*) guard keyed off the deprecated `mysql.user.password`
            // column, which is empty under MariaDB's default auth plugin (the hash lives in
            // authentication_string), so the guard could mis-evaluate and SKIP the rotation,
            // leaving a recreated container's sidecar password out of sync with the live DB
            // account (observed: a single-service `update` regenerated the sidecar password but
            // the `@'%'` row was never rotated -> ER_ACCESS_DENIED). ALTER USER ... IDENTIFIED BY
            // is idempotent, so running CREATE-IF-NOT-EXISTS + ALTER unconditionally is safe and
            // self-heals any sidecar-vs-DB drift.
            await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                "CREATE USER IF NOT EXISTS " + mariadbUser + " IDENTIFIED BY " + escapeSqlStringLiteral(userPassword)
            )
            await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                "ALTER USER " + mariadbUser + " IDENTIFIED BY " + escapeSqlStringLiteral(userPassword)
            )
            console.log("User " + mariadbUser + " ensured (password set)!")

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

            // Same shape as the MVH grant above, for the other suite that needs a
            // throwaway schema without a privileged account: the two-node parity drills
            // (xchain-e2e-test scripts/bet-parity-node.sh) clone the live indexer
            // database into a second one and run a SECOND indexer against it, to prove
            // two nodes commit identical state hashes over a lifecycle. Without this the
            // drill is BTC-only for a reason that has nothing to do with the protocol:
            // the BTC account happens to hold ALL PRIVILEGES on three "Drill" schemas
            // left behind by the flag-day drill, while every other chain's account holds
            // them on its own schema and nothing else, so node B's CREATE DATABASE is
            // refused (found taking the BET family cross-chain).
            //
            // Escaped underscores, so the pattern matches nothing but a DrillB schema.
            // Gated to non-mainnet, which is stricter than the MVH grant beside it:
            // these are drill venues, and there is no reason for a mainnet indexer
            // account to hold CREATE/DROP over any pattern at all.
            if (module === XChainService.XCHAIN_INDEXER && network && network !== "mainnet") {
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "GRANT ALL PRIVILEGES ON `XChain\\_%\\_DrillB\\_%`.* TO " + mariadbUser
                )
                await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, "FLUSH PRIVILEGES")
                console.log("DrillB parity-database permissions granted to " + mariadbUser + "!")
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

            // Force-set the password on every run (idempotent). See the docker branch above:
            // the old COUNT(*)/PASSWORD() guard keyed off the deprecated mysql.user.password
            // column and could skip the rotation, leaving the live account out of sync with the
            // per-install sidecar password. CREATE-IF-NOT-EXISTS + unconditional ALTER self-heals.
            await executeNativeMariaDbCommand(externalCfg,
                "CREATE USER IF NOT EXISTS " + mariadbUser + " IDENTIFIED BY " + escapeSqlStringLiteral(userPassword)
            )
            await executeNativeMariaDbCommand(externalCfg,
                "ALTER USER " + mariadbUser + " IDENTIFIED BY " + escapeSqlStringLiteral(userPassword)
            )
            console.log("User " + mariadbUser + " ensured (password set)!")

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

            // See the docker branch above: the same DrillB parity grant, since the
            // native-DB venues are exactly the ones that run these drills. Missing it
            // here would make the fix look chain-specific all over again, just on a
            // different axis.
            if (module === XChainService.XCHAIN_INDEXER && network && network !== "mainnet") {
                await executeNativeMariaDbCommand(externalCfg,
                    "GRANT ALL PRIVILEGES ON `XChain\\_%\\_DrillB\\_%`.* TO " + mariadbUser
                )
                await executeNativeMariaDbCommand(externalCfg, "FLUSH PRIVILEGES")
                console.log("DrillB parity-database permissions granted to " + mariadbUser + "!")
            }
            return true
        } catch (err) {
            console.log(err)
            throw err
        }
    }
}

async function setDatabaseParameters() {
    // Both callers (NodeService.installNode, ModuleService update) run this straight
    // after a decoder/indexer buildAndUp, and it is the ONLY step that writes the
    // freshly-minted per-install password into MariaDB. If the module set comes back
    // empty the loop body never executes and we used to `return true`, so the caller's
    // throw-on-error guard never fires and the install reports success while the new
    // container crash-loops on ER_ACCESS_DENIED. Provisioning nothing is never success
    // here: fail closed on an unready store and on an empty set alike.
    db.assertReady("setting decoder/indexer database parameters")

    const { getInstalledCoinsAndNetworks } = require('./StatusService')
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const dbContainerId = EXTERNAL_DB ? null : await getDatabaseContainerId()

    if (Object.keys(installedCoinsAndNetworks).length === 0) {
        throw new Error(
            "setDatabaseParameters found no installed coin/network, so no decoder/indexer MariaDB " +
            "account would be provisioned. The module registry is empty or unreadable."
        )
    }

    let accountsProvisioned = 0

    for (const nextCoin in installedCoinsAndNetworks) {
        for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
            try {
                // External DB has no container to attach to per-coin networks;
                // it's reachable via the bridge gateway from inside containers.
                if (!EXTERNAL_DB) {
                    await addContainerToNetwork(dbContainerId, getDockerNetwork(nextCoin, nextNetwork))
                }
                await statusChanged()

                // Refuse before the FIRST ALTER USER when a running container was built
                // from another install's config store and this rotation would lock it
                // out. Placed ahead of every write, so a refusal leaves the stack in the
                // state it was already in.
                const driftCfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                await assertNoDbCredentialDrift(nextCoin, nextNetwork, {
                    decoder: driftCfg["DECODER_DB_PASS"],
                    indexer: driftCfg["INDEXER_DB_PASS"]
                })

                let containerId = await db.getModuleContainer(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                if (containerId) {
                    const cfg = await getDefaultConfig(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                    await addUserPasswordToDatabase(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork, cfg["DECODER_DB_NAME"], cfg["DECODER_DB_USER"], cfg["DECODER_DB_PASS"])
                    accountsProvisioned++
                }

                containerId = await db.getModuleContainer(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                if (containerId) {
                    const cfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                    await addUserPasswordToDatabase(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork, cfg["INDEXER_DB_NAME"], cfg["INDEXER_DB_USER"], cfg["INDEXER_DB_PASS"])
                    await addUserPasswordToDatabase(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork, cfg["DECODER_DB_NAME"], cfg["DECODER_DB_USER"], cfg["DECODER_DB_PASS"])
                    accountsProvisioned += 2
                }
            } catch (err) {
                console.log(err)
                // Only claim a networking cause when the failure could plausibly be
                // one. A credential-drift refusal already carries its own diagnosis
                // and remediation, and appending a docker-network line to it sends
                // the operator hunting the wrong layer.
                if (!isDbCredentialDriftError(err)) {
                    console.log("There was a problem adding the database container to the docker network of " + nextCoin + " " + nextNetwork)
                }
                throw err
            }
        }
    }

    // A registry that lists coins but no decoder/indexer container is the same
    // silent-success hazard one level down: every getModuleContainer missed, so
    // nothing was force-set and the just-built container keeps a password that
    // exists nowhere in MariaDB.
    if (accountsProvisioned === 0) {
        throw new Error(
            "setDatabaseParameters provisioned no MariaDB account: the registry lists " +
            Object.keys(installedCoinsAndNetworks).join(", ") +
            " but holds no decoder or indexer container for them."
        )
    }

    return true
}

// Provision/rotate the SHARED hub DB account. setDatabaseParameters above covers the
// per-coin decoder/indexer accounts but not the hub (a shared service with no coin/network),
// so an `update xchain-hub` would rebuild the container with a new HUB_DB_PASS in its env yet
// leave the live hub account on the old password -> ER_ACCESS_DENIED lockout. Mirror the
// install-time provisioning (HubService.installHubModule) so a hub update force-sets the hub
// account to the configured password too. Reuses addUserPasswordToDatabase's unconditional
// CREATE IF NOT EXISTS + ALTER, so it self-heals any sidecar-vs-DB drift. The caller invokes
// this only after a successful hub buildAndUp, so the hub exists.
async function setHubDatabaseParameters() {
    const cfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    await addUserPasswordToDatabase(HUB_MODULE_NAME, "", "", cfg["HUB_DB_NAME"], cfg["HUB_DB_USER"], cfg["HUB_DB_PASS"])
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

const PRICE_FENCE_TABLE = 'price_ingest_watermarks'

// Clear the hub's price ingest fence row for one source chain.
//
// `price_ingest_watermarks` holds, per source chain, the highest rollback
// generation whose price retraction the hub has processed. PriceAggregator drops
// any push at or below that generation whose action_index sits in the retracted
// range. A reset indexer DB restarts its `push_generations` counter at 0 and,
// after replay, re-covers the same action indices, so EVERY price push from it
// matches that condition: the chain's price rail (and the native-fee /
// XCHAIN-USD path riding on it) stops, and until the hub-side warning landed
// nothing anywhere named the cause. So the fence row is cleared in the same step
// that wipes the indexer DB, never left to a runbook line.
//
// Returns true when the row was cleared, false when this MariaDB holds no hub DB
// to clear it in (a stack pushing to a hub elsewhere), in which case the manual
// statement is printed. Only the calling chain's row is touched: another chain's
// fence is still protecting that chain's live ingest.
async function clearHubPriceIngestWatermark(coin, network) {
    const ticker = CoinTickerSymbol[coin]
    if (!ticker) {
        throw new Error("clearHubPriceIngestWatermark: unknown coin '" + coin + "'")
    }

    const cfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    const hubDbName = cfg && cfg["HUB_DB_NAME"]
    if (!hubDbName) {
        warnPriceFenceNotCleared(ticker, "the hub configuration carries no HUB_DB_NAME")
        return false
    }
    // Same contract as addUserPasswordToDatabase: the DB name is an identifier
    // and cannot be bound, so allowlist it before it reaches a SQL string. The
    // ticker is a value and is escaped as a literal at the use site.
    assertSafeDbIdentifier(hubDbName, 'database name')

    let runner
    if (EXTERNAL_DB) {
        const externalCfg = await getExternalDbConfig()
        runner = (sql, options) => executeNativeMariaDbCommand(externalCfg, sql, options)
    } else {
        const mariadbContainerId = await getDatabaseContainerId()
        if (!mariadbContainerId) {
            warnPriceFenceNotCleared(ticker, "no MariaDB container was found")
            return false
        }
        const mariadbRootPassword = await askMariadbRootPassword(coin, network)
        runner = (sql, options) => executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, sql, options)
    }

    // Probe first rather than DELETE-and-swallow: a hub on another host (the
    // common prod shape) has no table here, and that case must print the manual
    // statement instead of being indistinguishable from a failed delete.
    const probe = await runner(
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = "
        + escapeSqlStringLiteral(hubDbName) + " AND TABLE_NAME = "
        + escapeSqlStringLiteral(PRICE_FENCE_TABLE), "-B -N")
    if (parseInt(String(probe).trim(), 10) !== 1) {
        warnPriceFenceNotCleared(ticker, "this MariaDB holds no " + hubDbName + "." + PRICE_FENCE_TABLE + " table")
        return false
    }

    await runner("DELETE FROM `" + hubDbName + "`." + PRICE_FENCE_TABLE
        + " WHERE source_chain = " + escapeSqlStringLiteral(ticker))
    console.log("Cleared the hub price ingest fence for " + ticker + " ("
        + hubDbName + "." + PRICE_FENCE_TABLE + ") so the rebuilt indexer's generation-0 pushes are accepted")
    return true
}

// One wording for every "could not clear it here" branch, so the operator always
// gets the exact statement to run on whichever DB the hub actually uses.
function warnPriceFenceNotCleared(ticker, reason) {
    console.warn("WARNING: the hub price ingest fence for " + ticker + " was NOT cleared (" + reason + ").")
    console.warn("  A reset indexer DB restarts its push_generations at 0, and the hub DROPS every")
    console.warn("  price push at or below its recorded retraction generation, taking that chain's price rail")
    console.warn("  and the native-fee / XCHAIN-USD path down with it. Run this on the hub's OWN database")
    console.warn("  before the indexer resumes pushing:")
    console.warn("    DELETE FROM " + PRICE_FENCE_TABLE + " WHERE source_chain = '" + ticker + "';")
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

        // Cap json-file log growth so a long-running node cannot fill the
        // host disk; sized to keep --tail reads inside a single rotated file.
        const runArgs = ['run', '-d', '--restart', 'unless-stopped', '--name', containerPrefix, '--hostname', 'mariadb', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3']
        // Visibility-only probe (#3876). A stalled-but-alive mariadbd was invisible
        // to `docker ps` and to anything reading container health, while
        // --restart unless-stopped only ever fires on process EXIT. Deliberately
        // not enrolled in autoheal: the DB has no SERVICE_HEALTHCHECK descriptor,
        // so AutohealService's `hc.autoheal !== true` gate skips it outright.
        runArgs.push('--health-cmd', 'healthcheck.sh --connect --innodb_initialized')
        runArgs.push('--health-interval', '15s', '--health-timeout', '5s', '--health-retries', '5', '--health-start-period', '60s')
        runArgs.push('--network', getDockerNetwork(coin, network))
        const dbHostPort = environmentVariables["DB_PORT"] || XCHAIN_NODE_DB_DEFAULT_PORT
        // Every other docker run port in this file is validated before reaching
        // execFile (see buildAndUp's portArgs loop); this one previously wasn't
        // (uuid:ee2849ef). No shell-injection risk either way (house execFile-
        // array convention), but an out-of-contract DB_PORT should fail loud
        // here instead of surfacing as a cryptic docker argument-parse error.
        if (!validatePort(dbHostPort)) {
            throw new Error("Invalid port value in configuration: DB_PORT=" + dbHostPort)
        }
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
        // multi-replica box (e.g. a shared services host serving xchain-sync
        // replicas across 18 DBs) wants a large buffer pool + a higher connection ceiling and
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
        // max_connections is the exception to "unset = image default": the image's 151
        // saturates on a shared multi-chain container (three chains' services plus one
        // e2e run sit just under it, and any extra consumer tips it over with misleading
        // "Can't connect to mariadb" errors - audit F-9). Default to the prod-standard
        // 1000; XCHAIN_NODE_DB_MAX_CONNECTIONS above still overrides, and idle threads
        // are cheap enough that single-chain installs are unaffected.
        if (!process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS) {
            runArgs.push('--max-connections=1000')
        }

        // Pre-flight host-port collision check (multi-stack hosts): same
        // guard the service-install path uses in ModuleService.buildAndUp. Two
        // different-NODE_PREFIX stacks on one host both try to bind the DB host
        // port; without this, `docker run` fails with a cryptic "port is already
        // allocated". Lazy require avoids a load-time cycle (ModuleService
        // requires this module at top).
        // Name-keyed cleanup immediately before `docker run --name`, making
        // (re)creation idempotent against a leftover carcass this registry-gated
        // branch (`if (!existingId)`) cannot see: a container that exists but
        // whose registry insert failed on an earlier run. Runs before the
        // port-conflict check so this container's own carcass never self-flags
        // as a conflict (uuid:9533ee7a).
        try {
            await forceRemoveContainerByName(containerPrefix)
        } catch { /* tolerant by design; see DockerService.forceRemoveContainerByName */ }

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
        // docker run succeeded (no error thrown) but stdout wasn't a clean 64-hex
        // id, e.g. a warning line printed before it. The container is running and
        // unregistered at this point; falling through with a plain `undefined`
        // return would let the caller treat this as success and leave an orphaned
        // container behind (uuid:fb0c275d).
        throw "Unexpected docker run output for " + DB_MODULE_NAME + " container: " + JSON.stringify(containerId)
    } else {
        // Existing-container branch. checkIfDatabaseModuleExists returns the id on
        // mere existence of State.Status, so a stopped/exited MariaDB container
        // reaches here and would otherwise be treated as installed: this function
        // returns success and the downstream readiness probe (checkIfDatabaseIsReady)
        // then burns ~100s of blind retries before aborting with a misleading
        // "MariaDB is not responding". Fail fast with an actionable message instead.
        //
        // We deliberately do NOT auto-start or recreate the container:
        //  - recreating would mean routing into the install branch above, which
        //    calls forceRemoveContainerByName + docker run and would orphan the
        //    MariaDB data volume (data loss);
        //  - auto-starting an operator-stopped container overrides a deliberate
        //    `docker stop` (the restart policy is unless-stopped, so a stop is
        //    plausibly intentional). That self-heal is an operator-policy decision,
        //    left out of scope here; the actionable error tells them what to run.
        let dbState = null
        try {
            const containerStatus = await getStatusFromContainer(existingId)
            dbState = containerStatus && containerStatus["State"] && containerStatus["State"]["Status"]
        } catch { /* inspect failed: fall through and let the existing path surface it */ }
        if (dbState && dbState !== 'running') {
            const name = getDockerContainerImageName(DB_MODULE_NAME, coin, network)
            throw new Error("MariaDB container " + name + " exists but is " + dbState + "; run: docker start " + name)
        }
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

        // Same allowlist/escape contract as addUserPasswordToDatabase: dbUser is
        // an identifier (validate), dbPassword may carry arbitrary bytes (escape).
        assertSafeDbIdentifier(dbUser, 'database user')
        console.log("Creating xchain-node database and user " + dbUser + " on external MariaDB")
        await executeNativeMariaDbCommand(externalCfg, "CREATE DATABASE IF NOT EXISTS " + XCHAIN_NODE_DB)
        await executeNativeMariaDbCommand(externalCfg, "CREATE USER IF NOT EXISTS '" + dbUser + "'@'%' IDENTIFIED BY " + escapeSqlStringLiteral(dbPassword))
        // Force password in case user exists from earlier with a different one
        await executeNativeMariaDbCommand(externalCfg, "ALTER USER '" + dbUser + "'@'%' IDENTIFIED BY " + escapeSqlStringLiteral(dbPassword))
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

    // Same allowlist/escape contract as addUserPasswordToDatabase: dbUser is an
    // identifier (validate), dbPassword may carry arbitrary bytes (escape).
    assertSafeDbIdentifier(dbUser, 'database user')
    console.log("Creating xchain-node database and user " + dbUser)
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "CREATE DATABASE IF NOT EXISTS " + XCHAIN_NODE_DB
    )
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "CREATE USER IF NOT EXISTS '" + dbUser + "'@'%' IDENTIFIED BY " + escapeSqlStringLiteral(dbPassword)
    )
    // Force the password in case the user existed with a different one (stale state)
    await executeDockerMariaDbCommand(containerId, rootPassword,
        "ALTER USER '" + dbUser + "'@'%' IDENTIFIED BY " + escapeSqlStringLiteral(dbPassword)
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
    setHubDatabaseParameters,
    buildDatabaseModule,
    resetDatabases,
    clearHubPriceIngestWatermark,
    getDatabaseContainerId,
    getDatabaseHostPort,
    ensureDatabasePool,
    ensureXchainNodeAccess
}
