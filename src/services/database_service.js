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
    EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT, EXTERNAL_DB_ROOT_USER,
    DEPENDENCY_HEALTH_START_PERIOD
} = require('../config')
const { db, getDbRootPassword, setDbRootPassword } = require('../state')
const { sleep, redactSecrets }    = require('../utils/helpers')
const { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../utils/sql_safety')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/docker_mariadb')
const { PING_SQL } = require('../db/connectivity')
const { schemaExistsSql, tableExistsSql, tablesExistSql } = require('../db/information_schema')
const {
    PRICE_FENCE_TABLE, FENCE_NETWORK_COLUMN, clearChainFenceSql, clearNetworkFenceSql,
    manualClearStatement
} = require('../db/price_fence')
const {
    CROSS_CHAIN_MATCH_TABLE, CROSS_CHAIN_CALL_TABLE, CAPABILITY_SNAPSHOT_TABLE,
    purgeAllMatchesSql, purgeAllCallsSql, purgeChainMatchesSql, purgeChainCallsSql,
    purgeCapabilitySnapshotsSql, foreignNetworkMatchCountSql,
    manualPurgeStatements, manualSnapshotPurgeStatement
} = require('../db/cross_chain')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork, getModuleDatabaseName, validatePort } = require('./config_service')
const { getStatusFromContainer, getDockerNetworkInspect, addContainerToNetwork, forceRemoveContainerByName, probeContainerPresenceByName } = require('./docker_service')
const { assertNoDbCredentialDrift, assertNoHubDbCredentialDrift, isDbCredentialDriftError } = require('./db_credential_drift')
const { statusChanged }           = require('./status_service')
const config = require('../config');
// Destructured where they are used, so each call reads the export at that moment.
const statusService = require('./status_service')
const peers = require('./peer_services').bindPeerServices(require)
const { getLogger } = require('../observability/logger');
const logger = getLogger();
const {
    XCHAIN_NODE_DB, getOsUserDbName, generatePassword,
    hasCredentials, loadCredentials, saveCredentials,
    hasExternalDbConfig, loadExternalDbConfig, saveExternalDbConfig,
    loadDbRootPassword, saveDbRootPassword
} = require('./credentials_service')

const { XCHAIN_NODE_DB_HOST, XCHAIN_NODE_DB_DEFAULT_PORT, getDatabaseContainerId, getDatabaseContainerPresence, getDatabaseHostPort, checkIfDatabaseModuleExists, checkIfDatabaseIsReady, configureDependencies: configureContainerAccess } = require('./database_service/container_access')
const { getExternalDbConfig, pingExternalDatabase, configureDependencies: configureExternalDb } = require('./database_service/external_db')
const { askMariadbRootPassword, executeDockerMariaDbCommand, executeNativeMariaDbCommand, configureDependencies: configureMariadbExec } = require('./database_service/mariadb_exec')
const { addUserPasswordToDatabase, configureDependencies: configureUserProvisioning } = require('./database_service/user_provisioning')
const { setDatabaseParameters, setHubDatabaseParameters, configureDependencies: configureDbParameters } = require('./database_service/db_parameters')
const { resetDatabases, clearHubPriceIngestWatermark, configureDependencies: configureResetDatabases } = require('./database_service/reset_databases')
const { purgeHubCrossChainRows, manualHubCrossChainPurgeStatements, configureDependencies: configureHubCrossChainPurge } = require('./database_service/hub_cross_chain_purge')
const { buildDatabaseModule, ensureXchainNodeAccess, configureDependencies: configureDatabaseModule } = require('./database_service/database_module')

const databaseServiceDependencies = { execFile, spawn, promisify, execFileAsync, mariadb, Password, Input, NumberPrompt, DB_MODULE_NAME, HUB_MODULE_NAME, XChainService, SEP, CoinTickerSymbol, EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT, EXTERNAL_DB_ROOT_USER, DEPENDENCY_HEALTH_START_PERIOD, db, getDbRootPassword, setDbRootPassword, sleep, redactSecrets, assertSafeDbIdentifier, escapeSqlStringLiteral, dockerMariadbArgs, mariadbEnv, PING_SQL, schemaExistsSql, tableExistsSql, tablesExistSql, PRICE_FENCE_TABLE, FENCE_NETWORK_COLUMN, clearChainFenceSql, clearNetworkFenceSql, manualClearStatement, CROSS_CHAIN_MATCH_TABLE, CROSS_CHAIN_CALL_TABLE, CAPABILITY_SNAPSHOT_TABLE, purgeAllMatchesSql, purgeAllCallsSql, purgeChainMatchesSql, purgeChainCallsSql, purgeCapabilitySnapshotsSql, foreignNetworkMatchCountSql, manualPurgeStatements, manualSnapshotPurgeStatement, getDefaultConfig, getDockerContainerImageName, getDockerNetwork, getModuleDatabaseName, validatePort, getStatusFromContainer, getDockerNetworkInspect, addContainerToNetwork, forceRemoveContainerByName, probeContainerPresenceByName, assertNoDbCredentialDrift, assertNoHubDbCredentialDrift, isDbCredentialDriftError, statusChanged, config, statusService, peers, getLogger, logger, XCHAIN_NODE_DB, getOsUserDbName, generatePassword, hasCredentials, loadCredentials, saveCredentials, hasExternalDbConfig, loadExternalDbConfig, saveExternalDbConfig, loadDbRootPassword, saveDbRootPassword }
configureContainerAccess(databaseServiceDependencies)
configureExternalDb(databaseServiceDependencies)
configureMariadbExec(databaseServiceDependencies)
configureUserProvisioning(databaseServiceDependencies)
configureDbParameters(databaseServiceDependencies)
configureResetDatabases(databaseServiceDependencies)
configureHubCrossChainPurge(databaseServiceDependencies)
configureDatabaseModule(databaseServiceDependencies)

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

module.exports = {
    checkIfDatabaseModuleExists,
    checkIfDatabaseIsReady,
    askMariadbRootPassword,
    executeDockerMariaDbCommand,
    executeNativeMariaDbCommand,
    getExternalDbConfig,
    pingExternalDatabase,
    addUserPasswordToDatabase,
    setDatabaseParameters,
    setHubDatabaseParameters,
    buildDatabaseModule,
    resetDatabases,
    clearHubPriceIngestWatermark,
    purgeHubCrossChainRows,
    manualHubCrossChainPurgeStatements,
    getDatabaseContainerId,
    getDatabaseContainerPresence,
    getDatabaseHostPort,
    ensureDatabasePool,
    ensureXchainNodeAccess
}
