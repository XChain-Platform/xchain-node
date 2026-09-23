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
let { HUB_MODULE_NAME, XChainService, EXTERNAL_DB } = require('../../config')
let { redactSecrets } = require('../../utils/helpers')
let { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../../utils/sql_safety')
let { schemaExistsSql } = require('../../db/information_schema')
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { getDatabaseContainerId, checkIfDatabaseIsReady } = require('./container_access')
let { getExternalDbConfig } = require('./external_db')
let { executeNativeMariaDbCommand, askMariadbRootPassword, executeDockerMariaDbCommand } = require('./mariadb_exec')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, HUB_MODULE_NAME, XChainService, EXTERNAL_DB, redactSecrets, assertSafeDbIdentifier, escapeSqlStringLiteral, schemaExistsSql, getLogger, logger } = dependencies)
}

// Fail fast when the DB container is missing or not ready, instead of
// burning ~100s of silent readiness retries and then issuing docker
// exec against a null container id with an opaque "mariadb command
// failed" error. getDatabaseContainerId() returns null when no MariaDB
// container exists at all (e.g. a fresh box), so check it first.
async function getDockerProvisioningRunner(mariadbRootPassword) {
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
    return (command, options) => executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, command, options)
}

// External (host-native) MariaDB path. Same DDL as the docker branch
// above, just sent over the network to the configured host instead
// of via `docker exec`. EXTERNAL_DB config is loaded fresh here so
// callers don't have to thread it through the parameter list.
async function getExternalProvisioningRunner() {
    const externalCfg = await getExternalDbConfig()
    return (command, options) => executeNativeMariaDbCommand(externalCfg, command, options)
}

async function ensureModuleDatabaseAndUser(run, databaseName, mariadbUser, userPassword) {
    const dbCount = await run(
        schemaExistsSql(databaseName), "-B -N"
    )
    if (dbCount == 0) {
        await run(
            "CREATE DATABASE IF NOT EXISTS " + databaseName
        )
        logger.info(redactSecrets("Database " + databaseName + " created!"))
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
    await run(
        "CREATE USER IF NOT EXISTS " + mariadbUser + " IDENTIFIED BY " + escapeSqlStringLiteral(userPassword)
    )
    await run(
        "ALTER USER " + mariadbUser + " IDENTIFIED BY " + escapeSqlStringLiteral(userPassword)
    )
    logger.info(redactSecrets("User " + mariadbUser + " ensured (password set)!"))

    let userGrants = await run(
        "SHOW GRANTS FOR " + mariadbUser, "-B -N"
    )
    userGrants = userGrants.replaceAll("`", "'").split("\n")
    if (!userGrants.includes("GRANT ALL PRIVILEGES ON '" + databaseName + "'.* TO " + mariadbUser)) {
        await run(
            "GRANT ALL PRIVILEGES ON " + databaseName + ".* TO " + mariadbUser
        )
        await run("FLUSH PRIVILEGES")
        logger.info(redactSecrets("Permissions granted to " + mariadbUser + "!"))
    }
}

// The e2e federation suites (xchain-e2e-test test:federation /
// test:attestation:llm) spin up throwaway in-process validator hubs
// via MultiValidatorHub, each creating + dropping its own DB named
// XChain_<coin>_<network>_MVH_<pid>_<n>. Grant the hub user CREATE/DROP
// on ONLY that test-only name pattern (escaped underscores → matches
// nothing but MVH databases) so those suites run without a privileged
// root account. Idempotent; harmless on networks that never run them.
async function grantHubTestDatabaseAccess(run, module, mariadbUser) {
    if (module === HUB_MODULE_NAME) {
        await run(
            "GRANT ALL PRIVILEGES ON `XChain\\_%\\_MVH\\_%`.* TO " + mariadbUser
        )
        await run("FLUSH PRIVILEGES")
        logger.info(redactSecrets("MVH test-database permissions granted to " + mariadbUser + "!"))
    }
}

// The sync server polls these accounts for the replication engine's view of
// their freshness, a read MariaDB 10.5 moved into SLAVE MONITOR: without it the
// probe fails closed and publishes every chain as stale. Global by nature (no
// per-schema form) but read-only, and granted here because a container recreate
// reprovisions the account and would otherwise drop it.
async function grantReplicationStatusAccess(run, module, mariadbUser) {
    if (module === XChainService.XCHAIN_INDEXER || module === XChainService.XCHAIN_DECODER) {
        await run(
            "GRANT SLAVE MONITOR ON *.* TO " + mariadbUser
        )
        await run("FLUSH PRIVILEGES")
        logger.info(redactSecrets("Replication-status read permission granted to " + mariadbUser + "!"))
    }
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
async function grantDrillDatabaseAccess(run, module, network, mariadbUser) {
    if (module === XChainService.XCHAIN_INDEXER && network && network !== "mainnet") {
        await run(
            "GRANT ALL PRIVILEGES ON `XChain\\_%\\_DrillB\\_%`.* TO " + mariadbUser
        )
        await run("FLUSH PRIVILEGES")
        logger.info(redactSecrets("DrillB parity-database permissions granted to " + mariadbUser + "!"))
    }
}

// The self-synced checkpoint mirror uses the same shape:
// HubService.buildCheckpointConfig names the schema
// `<INDEXER_DB_NAME>_HubMirror`, and the explorer's own
// HubMirrorSyncManager/HubMirrorPool.ensureDatabase() runs `CREATE
// DATABASE IF NOT EXISTS` on it under THIS SAME indexer account
// (db.js's _checkpointSource only honours a checkpoint entry whose
// host/port/user/pass exactly match the indexer DB, so the mirror
// writer has no separate credential to hold a separate grant).
// Escaped underscores, so the pattern matches nothing but a
// `_HubMirror` schema; gated to non-mainnet like DrillB, since
// self-sync is currently an opt-in for deployments with no
// externally-maintained hub schema colocated with the explorer.
async function grantHubMirrorDatabaseAccess(run, module, network, mariadbUser) {
    if (module === XChainService.XCHAIN_INDEXER && network && network !== "mainnet") {
        await run(
            "GRANT ALL PRIVILEGES ON `XChain\\_%\\_HubMirror`.* TO " + mariadbUser
        )
        await run("FLUSH PRIVILEGES")
        logger.info(redactSecrets("Checkpoint hub-mirror database permissions granted to " + mariadbUser + "!"))
    }
}

async function provisionDatabaseUser(run, module, network, databaseName, mariadbUser, userPassword) {
    await ensureModuleDatabaseAndUser(run, databaseName, mariadbUser, userPassword)
    await grantHubTestDatabaseAccess(run, module, mariadbUser)
    await grantReplicationStatusAccess(run, module, mariadbUser)
    await grantDrillDatabaseAccess(run, module, network, mariadbUser)
    await grantHubMirrorDatabaseAccess(run, module, network, mariadbUser)
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
    try {
        const run = useDocker
            ? await getDockerProvisioningRunner(mariadbRootPassword)
            : await getExternalProvisioningRunner()
        await provisionDatabaseUser(run, module, network, databaseName, mariadbUser, userPassword)
        return true
    } catch (err) {
        logger.info(err)
        throw err
    }
}


module.exports = { addUserPasswordToDatabase, configureDependencies }
