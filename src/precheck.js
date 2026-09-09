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
const { getDockerNetwork, applyHubApiKeyFromSidecar } = require('./services/ConfigService')
const { checkAllRemoteVersions }       = require('./services/VersionService')
const { getStatus }                    = require('./services/StatusService')
const { installHubModule, updateHub, isHubAnswering } = require('./services/HubService')
const { updateExplorer }               = require('./services/ExplorerService')
const { buildDatabaseModule, ensureXchainNodeAccess, getDatabaseHostPort, getExternalDbConfig } = require('./services/DatabaseService')
const { scanAndRegisterModules }       = require('./services/DiscoveryService')

function createDirectories() {
    if (!fs.existsSync(dataDir))             fs.mkdirSync(dataDir)
    if (!fs.existsSync(moduleDir))           fs.mkdirSync(moduleDir)
    if (!fs.existsSync(tmpDir))              fs.mkdirSync(tmpDir)
    if (!fs.existsSync(containersFilesDir))  fs.mkdirSync(containersFilesDir)
}

// The command about to run cannot be reached until the hub answers, so a hub
// that is down blocks the very command that would bring it back. Ask once,
// cheaply, whether it is answering. A guard, not a probe: a HubService without
// this export (an older stub) reports "answering" and preCheck behaves exactly
// as it did before, and any failure to even ask counts as not answering,
// because the config push that follows would fail the same way.
async function hubAnswersNow() {
    try {
        if (typeof isHubAnswering !== 'function') return true
        return await isHubAnswering()
    } catch {
        return false
    }
}

// The one line an operator needs when the hub is down and their command was not
// one that could fix it. Named here so the abort and the warning cannot drift.
const HUB_REPAIR_HINT =
    "Repair it with `xchain-node update xchain-hub` (or `xchain-node recreate xchain-hub`); " +
    "those run even while the hub is down. `docker logs` on the hub container says why it is not starting."

// `moduleRef` is the ref the command being prechecked named (`install <ref> ...`,
// `update <ref> ...`), or null. It exists solely so the hub provisioned here is
// staged at the ref the operator asked for: preCheck runs ahead of the action, so
// without it the one module installed from this file is also the one module no
// `install <ref>` could influence. See installHubModule.
//
// `repairsHub` says the command about to run rebuilds, recreates, updates or
// removes the hub container (cli.js commandRepairsHub decides). It only ever
// relaxes the config push below, and only while the hub is not answering.
async function preCheck(checkVersions = false, syncHubConfig = true, moduleRef = null, repairsHub = false) {
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

    // The CLI authenticates to the hub with the SAME credential the hub was deployed
    // with. `validator init` mints that key into config/hub.local, and getDefaultConfig
    // reads the sidecar when it builds the hub container's env, so the hub boots keyed;
    // but HubConnector only sends what is in process.env, which dotenv fills from .env
    // alone. On every validator host provisioned per the runbook that left the CLI's
    // own updateconfig push keyless against a keyed hub: `install xchain-hub` started
    // the hub and then failed with "HTTP 401" on its config push, and every
    // state-changing command after it did the same. Same precedence as the container
    // env: a host-env HUB_API_KEY still wins, the sidecar only fills an empty one, and
    // this never mints (a host with no sidecar stays keyless exactly as before).
    await applyHubApiKeyFromSidecar(process.env)

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
    //
    // A hub that is crash-looping (a rebuild that left it holding the wrong
    // database password is the usual way in) answers nothing, so the push spends
    // ten attempts on connection refusals and then aborts the command. It aborted
    // EVERY command, including the ones that rebuild the hub and end the crash
    // loop, which left deleting the container by hand as the only way out. So a
    // command that can repair the hub is let through on a warning while the hub
    // is not answering: the push is skipped rather than retried, the shared
    // containers are still attached to their coin networks (a docker operation,
    // which works on a container that is not serving), and the repair runs. This
    // never relaxes anything for a hub that IS answering, and a command that
    // cannot repair one still fails, now naming the command that can.
    if (syncHubConfig) {
        const hubAnswering = await hubAnswersNow()
        const skipHubPush  = !hubAnswering && repairsHub

        let firstErr = null
        try { await updateHub({ skipConfigPush: skipHubPush }) } catch (err) { firstErr = err }
        try { await updateExplorer() } catch (err) { if (!firstErr) firstErr = err }

        if (skipHubPush) {
            console.log("Warning: the xchain-hub is not answering, so its config push was skipped. " +
                "This command can repair the hub, so it continues; the next command that runs against a " +
                "healthy hub pushes the config.")
            if (firstErr) console.log(redactSecrets(firstErr))
            return true
        }
        if (firstErr) {
            console.log(redactSecrets(firstErr))
            throw new Error("There was an error trying to update the hub module" +
                (hubAnswering ? "" : ". The xchain-hub is not answering. " + HUB_REPAIR_HINT))
        }
    }

    return true
}

module.exports = { preCheck, createDirectories }
