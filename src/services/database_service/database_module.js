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

let { execFile } = require('child_process')
let { promisify } = require('util')
let path = require('path')
let execFileAsync = promisify(execFile)
let mariadb     = require('mariadb')

let {
    DB_MODULE_NAME, EXTERNAL_DB, DEPENDENCY_HEALTH_START_PERIOD
} = require('../../config')
let { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../../utils/sql_safety')
let { PING_SQL } = require('../../db/connectivity')
let { getDefaultConfig, getDockerContainerImageName, getDockerNetwork, validatePort } = require('../config_service')
let { getStatusFromContainer, addContainerToNetwork, forceRemoveContainerByName, probeContainerPresenceByName } = require('../docker_service')
let { statusChanged }           = require('../status_service')
let config = require('../../config');
let peers = require('../peer_services').bindPeerServices((file) => require(path.join('..', file)))
let { getLogger } = require('../../observability/logger');
let logger = getLogger();
let {
    XCHAIN_NODE_DB, getOsUserDbName, generatePassword,
    hasCredentials, loadCredentials, saveCredentials
} = require('../credentials_service')

let { XCHAIN_NODE_DB_HOST, XCHAIN_NODE_DB_DEFAULT_PORT, getDatabaseContainerId, checkIfDatabaseModuleExists, checkIfDatabaseIsReady } = require('./container_access')
let { getExternalDbConfig, pingMariaDb } = require('./external_db')
let { askMariadbRootPassword, executeNativeMariaDbCommand, executeDockerMariaDbCommand } = require('./mariadb_exec')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, promisify, execFileAsync, mariadb, DB_MODULE_NAME, EXTERNAL_DB, DEPENDENCY_HEALTH_START_PERIOD, assertSafeDbIdentifier, escapeSqlStringLiteral, PING_SQL, getDefaultConfig, getDockerContainerImageName, getDockerNetwork, validatePort, getStatusFromContainer, addContainerToNetwork, forceRemoveContainerByName, probeContainerPresenceByName, statusChanged, config, peers, getLogger, logger, XCHAIN_NODE_DB, getOsUserDbName, generatePassword, hasCredentials, loadCredentials, saveCredentials } = dependencies)
}

// External (host-native) MariaDB mode: xchain-node doesn't own the DB
// engine; the operator runs MariaDB themselves. We just need to confirm the
// configured external host is reachable and credentials work, then skip
// everything else. All downstream callers (precheck, ModuleService,
// moduleOperations, NodeService) are happy with this no-op return.
async function verifyExternalDatabase() {
    const cfg = await getExternalDbConfig()
    try {
        await pingMariaDb(cfg)
    } catch (err) {
        throw new Error("Cannot reach external MariaDB at " + cfg.host + ":" + cfg.port + ": " + (err.message || err))
    }
    return true
}

// Cap json-file log growth so a long-running node cannot fill the host
// disk, at the same 50m x 4 = 200 MB the module containers carry
// (ModuleService.buildAndUp holds the sizing arithmetic; spec
// proactive-system-watch, 2.0.5). The DB measured 37.7 KB/h on regtest
// 2026-08-30, so 10m x 3 = 30 MB missed the 48 h floor once the x10
// fleet inflation and x2 headroom are applied (36 MB needed); 200 MB
// clears it with room. --tail reads stay inside one rotated file.
//
// REACHABLE ONLY ON A MANUAL RECREATE. This branch runs on first
// install; the DB container is excluded from `update`
// (moduleOperations.js RECREATE/update paths) and from `recreate`
// (RECREATE_UNSUPPORTED_MODULES), so no automated fleet path re-applies
// it. An already-installed DB keeps 10m x 3 until an operator tears the
// container down and reinstalls it inside a maintenance window.
function createDatabaseRunArgs(containerPrefix, environmentVariables, coin, network) {
    const runArgs = ['run', '-d', '--restart', 'unless-stopped', '--name', containerPrefix, '--hostname', 'mariadb', '--log-opt', 'max-size=50m', '--log-opt', 'max-file=4']
    // A visibility-only probe makes a stalled-but-alive mariadbd observable
    // to `docker ps` and to anything reading container health, while
    // --restart unless-stopped only ever fires on process EXIT. Deliberately
    // not enrolled in autoheal: the DB has no SERVICE_HEALTHCHECK descriptor,
    // so AutohealService's `hc.autoheal !== true` gate skips it outright.
    runArgs.push('--health-cmd', 'healthcheck.sh --connect --innodb_initialized')
    // The start period is DEPENDENCY_HEALTH_START_PERIOD, shared with the hub and
    // explorer descriptors in ModuleService whose probes SELECT 1 against this
    // container: their grace windows are derived from this one, so widening
    // MariaDB's server-init budget widens theirs in the same edit instead of
    // leaving them judging a DB that is still starting.
    runArgs.push('--health-interval', '15s', '--health-timeout', '5s', '--health-retries', '5', '--health-start-period', DEPENDENCY_HEALTH_START_PERIOD)
    runArgs.push('--network', getDockerNetwork(coin, network))
    const dbHostPort = environmentVariables["DB_PORT"] || XCHAIN_NODE_DB_DEFAULT_PORT
    // Every docker run port in this file is validated before reaching
    // execFile (see buildAndUp's portArgs loop). No shell-injection risk
    // applies either way (house execFile-
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
    if (config.XCHAIN_NODE_DB_DATA_DIR) {
        runArgs.push('-v', `${config.XCHAIN_NODE_DB_DATA_DIR}:/var/lib/mysql`)
    }
    // Pass the root password through docker's OWN environment via a bare
    // `--env NAME` (value supplied in the execFile env below), NOT
    // `--env NAME=value` in argv. Otherwise the secret lands in the child
    // process command line, and a failed `docker run` rejects with it
    // embedded in err.cmd/err.message, which upstream error logging
    // (e.g. precheck's console.log(err)) would print. Mirrors the
    // mariadbEnv() MYSQL_PWD pattern used on the client path.
    runArgs.push('--env', 'MYSQL_ROOT_PASSWORD', containerPrefix)
    return { runArgs, dbHostPort }
}

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
function addDatabaseTuningArgs(runArgs) {
    const dbTuningArgs = {
        XCHAIN_NODE_DB_BUFFER_POOL_SIZE:        'innodb-buffer-pool-size',        // e.g. 16G
        XCHAIN_NODE_DB_MAX_CONNECTIONS:         'max-connections',               // e.g. 300
        XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT: 'innodb-flush-log-at-trx-commit' // e.g. 2 (faster, less durable)
    }
    for (const [envVar, mysqldFlag] of Object.entries(dbTuningArgs)) {
        const value = config.DB_TUNING_ENV[envVar]
        if (value) runArgs.push(`--${mysqldFlag}=${value}`)
    }
    // max_connections is the exception to "unset = image default": the image's 151
    // saturates on a shared multi-chain container (three chains' services plus one
    // e2e run sit just under it, and any extra consumer tips it over with misleading
    // "Can't connect to mariadb" errors - audit F-9). Default to the prod-standard
    // 1000; XCHAIN_NODE_DB_MAX_CONNECTIONS above still overrides, and idle threads
    // are cheap enough that single-chain installs are unaffected.
    if (!config.XCHAIN_NODE_DB_MAX_CONNECTIONS) {
        runArgs.push('--max-connections=1000')
    }
}

// Pre-flight host-port collision check (multi-stack hosts): same
// guard the service-install path uses in ModuleService.buildAndUp. Two
// different-NODE_PREFIX stacks on one host both try to bind the DB host
// port; without this, `docker run` fails with a cryptic "port is already
// allocated". Lazy require avoids a load-time cycle (ModuleService
// requires this module at top).
// Name-keyed cleanup immediately before `docker run --name`, making
// (re)creation idempotent against a leftover `Created`-state carcass.
// Runs before the port-conflict check so this container's own carcass
// never self-flags as a conflict.
//
// Gated on a POSITIVE absence, unlike the module and crypto-node install
// paths that share this shape (ModuleService.buildAndUp,
// NodeService.buildCryptoNode), because their target container is
// disposable and this one is the stack's only persistent data store: it
// holds xchain_node.modules plus every per-coin decoder/indexer schema,
// on an anonymous volume a recreate orphans.
//
// The branch condition is NOT evidence of absence. It reads
// checkIfDatabaseModuleExists, which swallows every error and also
// answers null on any inspect output that is not clean 64-hex, so a
// daemon hiccup, a slow inspect, or a container whose State probe failed
// all arrive here looking exactly like a fresh install, and the
// force-remove below would then be `docker rm -f` against a LIVE MariaDB.
// So re-probe and demand docker's own "no such container" before
// deleting anything, the same fail-safe StatusService.isContainerGoneError
// applies before dropping a registry row.
async function prepareDatabaseContainer(containerPrefix, dbHostPort) {
    const dbPresence = await probeContainerPresenceByName(containerPrefix)
    if (dbPresence !== 'gone') {
        throw new Error(
            "Refusing to (re)create the MariaDB container: docker reports '" + dbPresence + "' for container '" +
            containerPrefix + "', which is not a confirmed absence. This install path force-removes that container " +
            "and would orphan the database volume holding every module's data. Run `docker inspect " + containerPrefix +
            "` and `docker ps -a` to see what is actually there, then re-run once docker answers cleanly. " +
            "If the container is genuinely dead and you want it rebuilt from empty, remove it yourself first."
        )
    }
    try {
        await forceRemoveContainerByName(containerPrefix)
    } catch { /* tolerant by design; see DockerService.forceRemoveContainerByName */ }

    const { assertNoHostPortConflicts } = peers.moduleService
    await assertNoHostPortConflicts(['-p', `${XCHAIN_NODE_DB_HOST}:${dbHostPort}:3306`], containerPrefix)
}

async function startDatabaseContainer(runArgs, mariadbRootPassword) {
    logger.info("Creating container of module " + DB_MODULE_NAME)
    const { stdout } = await execFileAsync('docker', runArgs, {
        env: { ...config.childProcessEnv(), MYSQL_ROOT_PASSWORD: mariadbRootPassword }
    })
    const containerId = stdout.trim()
    if (/^[a-f0-9]{64}$/.test(containerId)) {
        // No db.setModuleContainer() call: the `modules` table lives
        // inside the container just created, so it doesn't exist yet.
        // Lookups instead use getDatabaseContainerId() (docker inspect by
        // name); DiscoveryService.discoverContainers() fills the row later.
        await statusChanged()
        return containerId
    }
    // docker run succeeded (no error thrown) but stdout wasn't a clean 64-hex
    // id, e.g. a warning line printed before it. The container is running and
    // unregistered at this point; falling through with a plain `undefined`
    // return would let the caller treat this as success and leave an orphaned
    // container behind.
    throw "Unexpected docker run output for " + DB_MODULE_NAME + " container: " + JSON.stringify(containerId)
}

async function createDatabaseModule(coin, network) {
    logger.info("Installing mariadb database...")
    const mariadbRootPassword = await askMariadbRootPassword(coin, network)
    const environmentVariables = await getDefaultConfig(DB_MODULE_NAME, coin, network)
    const containerPrefix = getDockerContainerImageName(DB_MODULE_NAME, coin, network)

    logger.info("Building image of database")
    await execFileAsync('docker', ['pull', 'mariadb:10.11'])
    await execFileAsync('docker', ['tag', 'mariadb:10.11', containerPrefix])
    const { runArgs, dbHostPort } = createDatabaseRunArgs(containerPrefix, environmentVariables, coin, network)
    addDatabaseTuningArgs(runArgs)
    await prepareDatabaseContainer(containerPrefix, dbHostPort)
    return startDatabaseContainer(runArgs, mariadbRootPassword)
}

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
async function reuseDatabaseModule(existingId, coin, network) {
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
        logger.info(err)
        throw "There was a problem trying to add the db container to the network " + coin + " " + network
    }
}

async function buildDatabaseModule(coin, network) {
    if (EXTERNAL_DB) return verifyExternalDatabase()
    const existingId = await checkIfDatabaseModuleExists(coin, network)
    if (!existingId) return createDatabaseModule(coin, network)
    return reuseDatabaseModule(existingId, coin, network)
}

async function ensureExternalXchainNodeAccess(existing) {
    const externalCfg = await getExternalDbConfig()

    // If existing creds work against the external DB, reuse them.
    if (existing) {
        try {
            const conn = await mariadb.createConnection({
                host: externalCfg.host, port: Number(externalCfg.port),
                user: existing.user, password: existing.password, database: XCHAIN_NODE_DB,
                connectTimeout: 5_000
            })
            await conn.query(PING_SQL)
            await conn.end()
            return existing
        } catch {
            logger.info("Stored xchain-node credentials no longer work against the external MariaDB; reprovisioning")
        }
    }

    const dbUser     = existing?.user     || getOsUserDbName()
    const dbPassword = existing?.password || generatePassword()

    // Same allowlist/escape contract as addUserPasswordToDatabase: dbUser is
    // an identifier (validate), dbPassword may carry arbitrary bytes (escape).
    assertSafeDbIdentifier(dbUser, 'database user')
    logger.info("Creating xchain-node database and user " + dbUser + " on external MariaDB")
    await executeNativeMariaDbCommand(externalCfg, "CREATE DATABASE IF NOT EXISTS " + XCHAIN_NODE_DB)
    await executeNativeMariaDbCommand(externalCfg, "CREATE USER IF NOT EXISTS '" + dbUser + "'@'%' IDENTIFIED BY " + escapeSqlStringLiteral(dbPassword))
    // Force password in case user exists from earlier with a different one
    await executeNativeMariaDbCommand(externalCfg, "ALTER USER '" + dbUser + "'@'%' IDENTIFIED BY " + escapeSqlStringLiteral(dbPassword))
    await executeNativeMariaDbCommand(externalCfg, "GRANT ALL PRIVILEGES ON " + XCHAIN_NODE_DB + ".* TO '" + dbUser + "'@'%'")
    await executeNativeMariaDbCommand(externalCfg, "FLUSH PRIVILEGES")

    const creds = { user: dbUser, password: dbPassword, database: XCHAIN_NODE_DB }
    saveCredentials(creds)
    logger.info("Credentials saved to user home directory")
    return creds
}

async function ensureDockerXchainNodeAccess(existing) {
    const containerId = await getDatabaseContainerId()
    if (!containerId) {
        throw new Error("MariaDB container not found; install it before requesting access")
    }

    if (existing) {
        // A credential probe, not a readiness wait, so it buys a short budget: the
        // failure this asks about (credentials.json copied from another host, or a
        // reset DB container) is permanent, and on the default 10x10s budget every
        // sleep was spent before reaching the reprovision below. preCheck calls this
        // while the global command lock is held (precheck.js -> cli.js), so those
        // ~100s blocked every other xchain-node invocation on the box with no output.
        // Two attempts, not one: a container whose socket is a beat behind still
        // gets a second chance, and the cost of losing that race is bounded anyway
        // (the reprovision re-stamps existing.password through idempotent DDL).
        const works = await checkIfDatabaseIsReady(existing.user, existing.password, XCHAIN_NODE_DB,
            { tries: 2, retryDelay: 1000 })
        if (works) return existing
        logger.info("Stored xchain-node credentials no longer work against this MariaDB (auth or xchain_node DB missing); reprovisioning")
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
    logger.info("Creating xchain-node database and user " + dbUser)
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
    logger.info("Credentials saved to user home directory")
    return creds
}

async function ensureXchainNodeAccess() {
    const existing = hasCredentials() ? loadCredentials() : null
    if (EXTERNAL_DB) return ensureExternalXchainNodeAccess(existing)
    return ensureDockerXchainNodeAccess(existing)
}

module.exports = { buildDatabaseModule, ensureXchainNodeAccess, configureDependencies }
