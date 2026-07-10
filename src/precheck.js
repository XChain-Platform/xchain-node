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
 * XChain Node - Precheck
 * Validates environment before any command runs
 ********************************************************************/

const fs = require('fs')

const { dataDir, moduleDir, tmpDir, containersFilesDir,
        EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT } = require('./config/constants')
const { db, isVerbose }                = require('./state')
const { redactSecrets }                = require('./utils/helpers')
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

async function preCheck(checkVersions = false, syncHubConfig = true) {
    try {
        if (isVerbose()) console.log("Checking if Docker is installed")
        await checkDockerInstalledAndReachable()
    } catch {
        throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
    }

    if (isVerbose()) console.log("Checking/Creating directories")
    createDirectories()

    // The bundled MariaDB container is started with `--network <xchain net>`
    // (DatabaseService.buildDatabaseModule), so the base network MUST exist
    // before it; otherwise a fresh box fails with "network not found".
    try {
        await createDockerNetwork(getDockerNetwork("", ""))
    } catch {
        throw new Error("There was an error trying to create the base xchain network")
    }

    if (isVerbose()) console.log("Checking/Installing mariadb container")
    try {
        await buildDatabaseModule("", "")
    } catch (err) {
        console.log(redactSecrets(err))
        throw new Error("There was an error installing the mariadb container")
    }

    if (isVerbose()) console.log("Checking/Creating xchain_node access for current user")
    let dbCreds
    try {
        dbCreds = await ensureXchainNodeAccess()
    } catch (err) {
        console.log(redactSecrets(err))
        throw new Error("There was an error creating xchain_node access")
    }

    if (isVerbose()) console.log("Opening MariaDB connection")
    try {
        // External-DB mode connects to the configured host:port directly.
        // Default (docker) mode reads the live port-forward from the running
        // container. Note: buildDatabaseModule is always called as ("", "")
        // above, and getDefaultConfig only reads a config file when both coin
        // and network are truthy, so a DB_PORT override in a coin/network
        // config file is unreachable on this path; the port is always
        // XCHAIN_NODE_DB_DEFAULT_PORT unless XCHAIN_NODE_DB_DATA_DIR-style env
        // plumbing is added for it (uuid:ee2849ef).
        const dbHost = EXTERNAL_DB ? EXTERNAL_DB_HOST : "127.0.0.1"
        const dbPort = EXTERNAL_DB ? EXTERNAL_DB_PORT : await getDatabaseHostPort()
        await db.createDatabase({
            host:     dbHost,
            port:     dbPort,
            user:     dbCreds.user,
            password: dbCreds.password,
            database: dbCreds.database
        })
    } catch (err) {
        console.log(redactSecrets(err))
        throw new Error("Couldn't open the xchain_node MariaDB database")
    }

    try {
        // Always reconcile against `docker ps -a`: adds missing rows
        // (the original empty-table case), updates stale container_ids
        // when containers were recreated outside the CLI, and purges
        // orphan rows whose containers were deleted externally. Without
        // this, downstream operations log "container not found" /
        // "couldn't connect to network" warnings against phantom IDs.
        await scanAndRegisterModules({ silent: !isVerbose() })
    } catch (err) {
        console.log(redactSecrets(err))
        throw new Error("There was an error during module auto-discovery")
    }
    if (checkVersions) {
        if (isVerbose()) console.log("Getting all remote project versions")
        await checkAllRemoteVersions()
    }
    if (isVerbose()) console.log("Getting modules status")
    await getStatus(null, null, false, checkVersions)

    try {
        if (isVerbose()) console.log("Checking/Installing hub module")
        await installHubModule()
    } catch {
        throw new Error("There was an error trying to install the hub module")
    }

    // Only push local config to the hub/explorer for state-changing commands.
    // Read-only commands (ps, tail, logs, …) pass syncHubConfig=false to skip
    // this step. The updateconfig round-trip can be slow on multi-coin nodes and
    // pushing it adds nothing when local service state hasn't changed.
    if (syncHubConfig) {
        try {
            await updateHub()
            await updateExplorer()
        } catch (err) {
            console.log(redactSecrets(err))
            throw new Error("There was an error trying to update the hub module")
        }
    }

    return true
}

module.exports = { preCheck, createDirectories }
