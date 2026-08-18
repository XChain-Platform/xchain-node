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
        EXTERNAL_DB } = require('./config/constants')
const { db, isVerbose }                = require('./state')
const { redactSecrets }                = require('./utils/helpers')
const { checkDockerInstalledAndReachable, createDockerNetwork, checkContainerdDataRootRelocation } = require('./services/DockerService')
const { getDockerNetwork } = require('./services/ConfigService')
const { checkAllRemoteVersions }       = require('./services/VersionService')
const { getStatus }                    = require('./services/StatusService')
const { installHubModule, updateHub }  = require('./services/HubService')
const { updateExplorer }               = require('./services/ExplorerService')
const { buildDatabaseModule, ensureXchainNodeAccess, getDatabaseHostPort, getExternalDbConfig } = require('./services/DatabaseService')
const { scanAndRegisterModules }       = require('./services/DiscoveryService')

function createDirectories() {
    if (!fs.existsSync(dataDir))             fs.mkdirSync(dataDir)
    if (!fs.existsSync(moduleDir))           fs.mkdirSync(moduleDir)
    if (!fs.existsSync(tmpDir))              fs.mkdirSync(tmpDir)
    if (!fs.existsSync(containersFilesDir))  fs.mkdirSync(containersFilesDir)
}

// `moduleRef` is the ref the command being prechecked named (`install <ref> ...`,
// `update <ref> ...`), or null. It exists solely so the hub provisioned here is
// staged at the ref the operator asked for: preCheck runs ahead of the action, so
// without it the one module installed from this file is also the one module no
// `install <ref>` could influence. See installHubModule.
async function preCheck(checkVersions = false, syncHubConfig = true, moduleRef = null) {
    try {
        if (isVerbose()) console.log("Checking if Docker is installed")
        await checkDockerInstalledAndReachable()
    } catch {
        throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
    }

    // Warn (never block) when Docker's data-root was relocated off the
    // root filesystem but containerd's store was left behind on `/`, where it
    // silently fills the root disk. Guarded + best-effort: a stubbed/older
    // DockerService without this probe, or any failure, degrades to a no-op.
    try {
        if (typeof checkContainerdDataRootRelocation === 'function') {
            const relo = await checkContainerdDataRootRelocation()
            if (relo) {
                console.log(
                    "Warning: Docker's data-root is on a separate disk (" + relo.dockerRootDir + "), " +
                    "but containerd's store is still on the root filesystem (" + relo.containerdRoot + "). " +
                    "The Docker data-root setting does NOT move containerd's content/snapshot store, so it " +
                    "keeps growing on `/` and can fill the root disk. Relocate containerd too: point its `root` " +
                    "(in /etc/containerd/config.toml, or bind-mount " + relo.containerdRoot + ") onto the same disk " +
                    "and restart the containerd + docker services. Set XCHAIN_NODE_CONTAINERD_ROOT to silence a false positive."
                )
            }
        }
    } catch {
        // Diagnostic only; never block a command on the containerd probe.
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
        // External mode resolves host/port through getExternalDbConfig() (env →
        // saved credentials.json → prompt), NOT the load-time EXTERNAL_DB_HOST/PORT
        // constants: those only carry env vars or the 127.0.0.1:3306 defaults, so a
        // host the operator entered at the first-run prompt would be ignored and this
        // pool would open against the wrong server. Same resolution ensureDatabasePool
        // uses (uuid:52c5b5f1).
        // Default (docker) mode reads the live port-forward from the running
        // container. Note: buildDatabaseModule is always called as ("", "") above,
        // and getDefaultConfig only reads a config file when both coin and network
        // are truthy, so a DB_PORT override in a coin/network config file is
        // unreachable on this path; the port is always XCHAIN_NODE_DB_DEFAULT_PORT
        // unless XCHAIN_NODE_DB_DATA_DIR-style env plumbing is added (uuid:ee2849ef).
        let dbHost, dbPort
        if (EXTERNAL_DB) {
            const extCfg = await getExternalDbConfig()
            dbHost = extCfg.host
            dbPort = extCfg.port
        } else {
            dbHost = "127.0.0.1"
            dbPort = await getDatabaseHostPort()
        }
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
        try {
            await checkAllRemoteVersions()
        } catch (err) {
            // GitHub API 403 rate limits (or transient network failures) must
            // not abort the whole command: version info is advisory. Degrade
            // to a status listing without remote-version columns.
            console.log("Warning: couldn't fetch remote versions (GitHub unreachable or rate-limited); continuing without version check: " + redactSecrets(err))
            checkVersions = false
        }
    }
    if (isVerbose()) console.log("Getting modules status")
    await getStatus(null, null, false, checkVersions)

    try {
        if (isVerbose()) console.log("Checking/Installing hub module")
        await installHubModule(moduleRef)
    } catch (err) {
        // Preserve the cause. A bare `catch {}` here discarded the ONLY description
        // of what actually went wrong and replaced it with a message that names no
        // reason, so every hub install failure looked identical and was undebuggable
        // without editing this file first. Secrets are redacted because
        // installHubModule handles DB credentials.
        throw new Error("There was an error trying to install the hub module: " + redactSecrets(err), { cause: err })
    }

    // Only push local config to the hub/explorer for state-changing commands.
    // Read-only commands (ps, tail, logs, …) pass syncHubConfig=false to skip
    // this step. The updateconfig round-trip can be slow on multi-coin nodes and
    // pushing it adds nothing when local service state hasn't changed.
    // Attempt both pushes even when the first rejects: updateHub() reports
    // shared containers it could not attach to a coin network, and letting that
    // skip the explorer push would strand a second service on stale config for
    // a fault that has nothing to do with it. The first error is still what the
    // operator sees, and the command still fails.
    if (syncHubConfig) {
        let firstErr = null
        try { await updateHub() }      catch (err) { firstErr = err }
        try { await updateExplorer() } catch (err) { if (!firstErr) firstErr = err }
        if (firstErr) {
            console.log(redactSecrets(firstErr))
            throw new Error("There was an error trying to update the hub module")
        }
    }

    return true
}

module.exports = { preCheck, createDirectories }
