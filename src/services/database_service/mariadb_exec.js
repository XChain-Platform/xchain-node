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


let { execFile, spawn } = require('child_process')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let mariadb = require('mariadb')
let { Password } = require('enquirer')
let { EXTERNAL_DB } = require('../../config')
let { getDbRootPassword, setDbRootPassword } = require('../../state')
let { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
let config = require('../../config')
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { loadDbRootPassword, saveDbRootPassword } = require('../credentials_service')
let { checkIfDatabaseModuleExists } = require('./container_access')
let { getExternalDbConfig } = require('./external_db')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, spawn, execFileAsync, mariadb, Password, EXTERNAL_DB, getDbRootPassword, setDbRootPassword, dockerMariadbArgs, mariadbEnv, config, getLogger, logger, loadDbRootPassword, saveDbRootPassword } = dependencies)
}

// Read a mariadb client option string the way the client itself reads argv:
// short flags cluster, so "-BN" means "-B -N". The docker path hands this same
// string to a real client that clusters (executeDockerMariaDbCommand splits it
// straight into argv), and the native helper below claims to mirror it, so a
// clustered spelling must not quietly mean "not batch mode": that returns '' for
// a SELECT, and every caller parseInts '' into NaN, which compares false against
// every threshold and reads as "nothing found" (an absent halt marker, an empty
// database). Only the flags this helper implements are recognized; an unknown
// one is ignored exactly as it is today.
function parseMariaDbClientOptions(commandOptions) {
    let batchMode = false
    let noHeaders = false
    for (const token of String(commandOptions || '').trim().split(/\s+/)) {
        if (!token || token[0] !== '-') continue
        if (token.startsWith('--')) {
            if (token === '--batch')             batchMode = true
            if (token === '--skip-column-names') noHeaders = true
            continue
        }
        // A short-flag token is a cluster of single letters ("-BN" == "-B -N").
        if (token.includes('B')) batchMode = true
        if (token.includes('N')) noHeaders = true
    }
    return { batchMode, noHeaders }
}

// Execute a single SQL statement against the external (host-native) MariaDB
// as the root user. Mirrors the interface of executeDockerMariaDbCommand
// so callers can switch on EXTERNAL_DB without changing their structure.
// commandOptions is honored for batch/no-headers ("-B -N", the clustered
// "-BN", and the long forms) which existing callers use to parse single-value
// queries.
async function executeNativeMariaDbCommand(externalCfg, command, commandOptions = "") {
    const { batchMode, noHeaders } = parseMariaDbClientOptions(commandOptions)

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

async function rootPasswordFromConfig(dbContainerId) {
    if (config.XCHAIN_NODE_DB_ROOT_PASSWORD) {
        const envPassword = config.XCHAIN_NODE_DB_ROOT_PASSWORD
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
        // indication the root password was the problem.
        try {
            const ping = await execFileAsync('docker', dockerMariadbArgs(dbContainerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(envPassword) })
            if (ping.stdout.includes('mysqld is alive')) {
                setDbRootPassword(envPassword)
                saveDbRootPassword(envPassword)
                return envPassword
            }
        } catch { /* fall through to the container-env read / prompt below */ }
        // Say so when the override loses. The fall-through is correct, but an
        // operator who set this variable believes it IS the credential in force,
        // so a silent switch to the container's own password hides exactly the
        // half-done rotation this resolver exists to survive.
        // Names the variable, never a value: this line reaches logs and CI output.
        logger.warn('WARNING: XCHAIN_NODE_DB_ROOT_PASSWORD did not authenticate against the running '
            + 'MariaDB container and is being ignored; falling back to the container\'s own '
            + 'MYSQL_ROOT_PASSWORD. Rotate both sides, or unset the variable.')
    }
    return null
}

    // If the mariadb container is already up, its MYSQL_ROOT_PASSWORD env is
    // the source of truth. Read it directly so non-interactive runs (CI, the
    // review system's release-check producer, scripted resets) don't hang on
    // a stdin prompt. Falls through to the prompt if the env isn't readable.
async function rootPasswordFromContainer(dbContainerId) {
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
    return null
}

    // Last non-interactive source: the copy persisted to credentials.json the
    // last time a root password was accepted. Covers installs whose DB
    // container carries no MYSQL_ROOT_PASSWORD env (created before the
    // env-injection path), where the printenv read above has nothing to find.
    // Verified with a ping before trusting, same as the env override; only
    // consulted when a container exists to verify against, so a stale copy
    // can never silently become a fresh install's root password.
async function rootPasswordFromCredentials(dbContainerId) {
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
    return null
}

    // Non-interactive run (cron, ssh BatchMode, CI): enquirer's prompt would
    // block forever on a stdin that never answers (observed as a multi-hour
    // hang on a scripted `update`). Fail fast with the ways to supply the
    // password instead.
async function promptForRootPassword(dbContainerId) {
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
                    logger.info("Wrong password, please try again")
                }
            } else {
                setDbRootPassword(answer)
                saveDbRootPassword(answer)
                return answer
            }
        } catch (err) {
            logger.info("An error has occurred asking for database password")
            throw err
        }
    }
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
    const configured = await rootPasswordFromConfig(dbContainerId)
    if (configured) return configured
    const fromContainer = await rootPasswordFromContainer(dbContainerId)
    if (fromContainer) return fromContainer
    const stored = await rootPasswordFromCredentials(dbContainerId)
    if (stored) return stored
    return promptForRootPassword(dbContainerId)
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

module.exports = { parseMariaDbClientOptions, executeNativeMariaDbCommand, scrubSqlFromError, askMariadbRootPassword, executeDockerMariaDbCommand, configureDependencies }
