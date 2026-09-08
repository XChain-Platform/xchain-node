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
 * XChain Node - Status Service
 * Tracks installed modules and container status
 ********************************************************************/

const {
    NODE_MODULE_NAME, SEP, Coin, Network, XChainService
} = require('../config/constants')
const {
    db,
    getInstalledModules, setInstalledModules, resetInstalledModules,
    getRemoteModuleVersions,
    isStatusUpdated, setStatusUpdated,
    getLastStatus, setLastStatus,
    getLastPrintedStatus, setLastPrintedStatus, appendLastPrintedStatus
} = require('../state')
const { getStatusFromContainer }         = require('./DockerService')
const { checkRemoteNodeVersion }         = require('./VersionService')
const { getLocalNodeVersion, getContainerNodeVersion, getLocalModuleVersion, getContainerModuleVersion } = require('./VersionService')

// Distinguish a `docker inspect` failure that means the container is genuinely
// gone (safe to reconcile out of the persistent registry) from a transient one
// (daemon down, timeout, permission) where the container may still be live.
// `docker inspect <id>` on a missing id exits non-zero with "No such
// object/container"; anything we cannot positively identify as gone is treated
// as transient, so an ambiguous error never deletes a registry row (fail-safe:
// keep the row rather than risk dropping a live container from management).
function isContainerGoneError(err) {
    if (!err) return false
    const text = String((err.stderr || '') + ' ' + (err.message || '')).toLowerCase()
    return /no such (object|container|image)/.test(text)
}

// The two config pushes are independent targets, so neither may cancel the
// other. updateHub() now rejects when a shared container could not be attached
// to a coin network (it used to swallow that and return true), and a plain
// sequential await would have made that rejection ALSO skip the explorer push,
// stranding the explorer on stale config on top of the unreachable network.
// Run both, then report: the first error still propagates, so every caller
// keeps failing loudly, but only the step that actually failed is lost.
async function statusChanged() {
    setStatusUpdated(false)
    const { updateHub }      = require('./HubService')
    const { updateExplorer } = require('./ExplorerService')

    let firstErr = null
    try { await updateHub() }      catch (err) { firstErr = err }
    try { await updateExplorer() } catch (err) { if (!firstErr) firstErr = err }
    if (firstErr) throw firstErr
}

async function getInstalledCoinsAndNetworks() {
    const modulesStatus = await getStatus(null, null, false)
    const result = {}

    for (const nextCoin in modulesStatus) {
        if (Object.values(Coin).includes(nextCoin)) {
            result[nextCoin] = []
            for (const nextNetwork in modulesStatus[nextCoin]) {
                if (Object.values(Network).includes(nextNetwork)) {
                    result[nextCoin].push(nextNetwork)
                }
            }
        }
    }

    return result
}

async function loadInstalledModules(coin, network, checkVersions = false) {
    if (checkVersions) await checkRemoteNodeVersion(coin, network)
    const modules = await db.getAllModuleContainers(coin, network)

    for (const nextModule of modules) {
        const { module, coin: c, network: n, container_id } = nextModule
        const installedModules = getInstalledModules()

        if (!(c in installedModules)) installedModules[c] = {}
        if (!(n in installedModules[c])) installedModules[c][n] = {}
        if (!(module in installedModules[c][n])) installedModules[c][n][module] = {}

        installedModules[c][n][module]["container_id"] = container_id
    }
}

// The decoder's `health` JSON-RPC answer, reduced to its REORG_HALT fields, or
// null when the surface is unreadable. Required late: BootstrapHealthGate pulls
// in DatabaseService, and StatusService is itself required from the operations
// layer that DatabaseService reaches back into. The 15s ceiling keeps a wedged
// container from holding `ps` hostage.
async function probeDecoderReorgHalt(containerId, coin, network) {
    const { probeServiceStatus, MODULE_API_PORT_KEY } = require('./BootstrapHealthGate')
    const { getDefaultConfig } = require('./ConfigService')
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const runner = (cmd, args) => promisify(execFile)(cmd, args, { timeout: 15000 })
    const config = await getDefaultConfig(XChainService.XCHAIN_DECODER, coin, network)
    const port = config && config[MODULE_API_PORT_KEY[XChainService.XCHAIN_DECODER]]
    if (!port) return null
    const payload = await probeServiceStatus(containerId, port, runner)
    return reduceDecoderReorgHalt(payload)
}

// The REORG_HALT fields of a decoder health payload, or null for anything that
// is not a payload. Strict `=== true` on the flag: an older image without the
// field reads as not halted rather than as a halt.
function reduceDecoderReorgHalt(payload) {
    if (!payload || typeof payload !== 'object') return null
    return {
        halted:         payload.reorg_halted === true,
        at:             payload.reorg_halted_at || null,
        reason:         payload.reorg_halt_reason || null,
        cleared_at:     payload.reorg_halt_cleared_at || null,
        cleared_reason: payload.reorg_halt_cleared_reason || null
    }
}

// The line `ps` prints under the table for a halted decoder: what it means,
// since when, why, and both recoveries (the clear names its own preconditions).
function describeReorgHaltNote(coin, network, reorgHalt) {
    return coin + "/" + network + " xchain-decoder carries a durable REORG_HALT marker"
        + (reorgHalt.at ? " since " + reorgHalt.at : "")
        + ": it parses forward but will refuse the next reorg and stop."
        + (reorgHalt.reason ? " " + reorgHalt.reason : "")
        + " Recovery: a full resync, or once the rolled-back range is re-parsed and the database is verified intact, "
        + "`xchain-node clear-reorg-halt " + coin + " " + network + " --reason \"...\"`."
}

async function getStatus(coin, network, printStatus = false, checkVersions = false) {
    if (isStatusUpdated()) {
        if (printStatus) console.log(getLastPrintedStatus())
        return getLastStatus()
    }

    if (!db.isReady()) {
        // DB pool not opened yet (e.g. statusChanged() fired during early precheck)
        // Return empty without caching, so a later call re-reads the modules table
        return {}
    }

    setLastPrintedStatus("")
    resetInstalledModules()
    await loadInstalledModules(coin, network, checkVersions)

    const installedModules = getInstalledModules()
    const remoteModuleVersions = getRemoteModuleVersions()

    const rows = []
    // Lines printed under the table for states a column cannot explain.
    const notes = []

    if (Object.keys(installedModules).length > 0) {
        for (const nextCoin in installedModules) {
            if (checkVersions && !(NODE_MODULE_NAME + SEP + nextCoin in remoteModuleVersions)) {
                await checkRemoteNodeVersion(nextCoin)
            }

            const nextCoinNetworks = installedModules[nextCoin]

            for (const nextCoinNetwork in nextCoinNetworks) {
                const nextCoinNetworkModules = installedModules[nextCoin][nextCoinNetwork]
                const moduleKeys = Object.keys(nextCoinNetworkModules)

                if (moduleKeys.length > 0) {
                    const toRemove = []

                    for (const nextModule in nextCoinNetworkModules) {
                        const containerId = nextCoinNetworkModules[nextModule]["container_id"]
                        try {
                            const containerStatus = await getStatusFromContainer(containerId)
                            nextCoinNetworkModules[nextModule]["status"] = containerStatus

                            let remoteVersion = "-"
                            try {
                                if (nextModule === NODE_MODULE_NAME) {
                                    remoteVersion = remoteModuleVersions[nextModule + SEP + nextCoin]["tag_name"].substring(1)
                                } else {
                                    remoteVersion = remoteModuleVersions[nextModule]
                                }
                                nextCoinNetworkModules[nextModule]["remote_version"] = remoteVersion
                            } catch { /* not available yet */ }

                            let localVersion = "-"
                            try {
                                if (nextModule === NODE_MODULE_NAME) {
                                    localVersion = await getLocalNodeVersion(nextCoin, nextCoinNetwork)
                                } else {
                                    localVersion = await getLocalModuleVersion(nextModule)
                                }
                                nextCoinNetworkModules[nextModule]["local_version"] = localVersion
                            } catch { /* not available yet */ }

                            let containerVersion = "-"
                            try {
                                if (nextModule === NODE_MODULE_NAME) {
                                    containerVersion = await getContainerNodeVersion(nextCoin, nextCoinNetwork, containerId)
                                } else {
                                    containerVersion = await getContainerModuleVersion(nextModule, nextCoin, nextCoinNetwork, containerId)
                                }
                                nextCoinNetworkModules[nextModule]["container_version"] = containerVersion
                            } catch { /* not available yet */ }

                            let branch = "-"
                            if (nextModule !== NODE_MODULE_NAME) {
                                const { getModuleBranch } = require('./ModuleService')
                                try { branch = await getModuleBranch(nextModule) } catch { /* not available */ }
                            }

                            // The commit THIS container's image was built from, stamped
                            // as an image label by ModuleService.buildAndUp.
                            //
                            // Read from the container, never from the module checkout:
                            // the checkout is a single shared directory that moves with
                            // every update, so reporting its commit here would claim
                            // today's code for a container built days ago. That is the
                            // exact class of lie the version column already tells, since
                            // a module's package.json version stays put across dozens of
                            // commits. Blank when the image predates the label.
                            let commit = "-"
                            try {
                                const labels = containerStatus["Config"]["Labels"] || {}
                                const stamped = labels["xchain.source.commit"]
                                if (typeof stamped === "string" && /^[a-f0-9]{40}$/.test(stamped)) {
                                    commit = stamped.slice(0, 12)
                                }
                            } catch { /* no Config/Labels on this inspect payload */ }

                            // Fold restart churn and healthcheck status into the
                            // displayed state so a container being cycled by
                            // `--restart unless-stopped`, or one whose configured
                            // healthcheck (see ModuleService.buildHealthcheckArgs)
                            // is failing, doesn't print a reassuring plain
                            // "running" indistinguishable from a clean uptime.
                            // RestartCount is TOP-LEVEL in `docker inspect` output, a sibling
                            // of State, not a field inside it: State carries only Status,
                            // Running, Restarting, StartedAt, Health and friends. Read from
                            // State it was always undefined, so the churn branch below never
                            // fired and a cycling container printed a clean green "running".
                            const restartCount = containerStatus["RestartCount"] || 0
                            const healthStatus = containerStatus["State"]["Health"] && containerStatus["State"]["Health"]["Status"]
                            let state = containerStatus["State"]["Status"]
                            let isChurning = false
                            if (restartCount > 0) {
                                state += " x" + restartCount
                                isChurning = true
                            }
                            if (healthStatus && healthStatus !== "healthy") {
                                state += " (" + healthStatus + ")"
                                isChurning = true
                            }

                            // A decoder carrying a durable REORG_HALT marker keeps parsing
                            // and reports a healthy healthcheck (api.js keeps the marker off
                            // the healthcheck on purpose: autoheal would restart-loop a
                            // service that is doing useful work), so nothing above shows
                            // it. The decoder's own health surface does. Read it here for
                            // running decoders, advisory only: a probe that fails changes
                            // nothing, and the note under the table names the recovery.
                            let reorgHalt = null
                            if (nextModule === XChainService.XCHAIN_DECODER && containerStatus["State"]["Status"] === "running") {
                                try {
                                    reorgHalt = await probeDecoderReorgHalt(containerId, nextCoin, nextCoinNetwork)
                                } catch { /* advisory: an unreadable surface is not a halt */ }
                                if (reorgHalt && reorgHalt.halted) {
                                    state += " REORG_HALT"
                                    isChurning = true
                                    nextCoinNetworkModules[nextModule]["reorg_halt"] = reorgHalt
                                    notes.push(describeReorgHaltNote(nextCoin, nextCoinNetwork, reorgHalt))
                                }
                            }
                            const name        = nextModule
                            const rawPorts    = containerStatus["NetworkSettings"]["Ports"] || {}
                            const portParts   = []
                            for (const [containerPort, bindings] of Object.entries(rawPorts)) {
                                if (bindings && bindings.length > 0) {
                                    for (const binding of bindings) {
                                        portParts.push(binding.HostIp + ":" + binding.HostPort + "->" + containerPort)
                                    }
                                }
                            }
                            rows.push({
                                name,
                                coin:    nextCoin    || "-",
                                network: nextCoinNetwork || "-",
                                branch,
                                commit,
                                state,
                                isChurning,
                                ports: portParts.length > 0 ? portParts.join(", ") : "-"
                            })

                        } catch (err) {
                            if (isContainerGoneError(err)) {
                                // Docker confirms the container no longer exists:
                                // reconcile the persistent registry too, not only
                                // in-memory status, so start/stop/update/uninstall
                                // stop resolving a dead container id (the row would
                                // otherwise linger forever after an out-of-band
                                // `docker rm`). Best-effort: an in-memory prune still
                                // happens even if the registry delete fails.
                                toRemove.push(nextModule)
                                try {
                                    await db.removeModuleContainer(nextModule, nextCoin, nextCoinNetwork)
                                } catch { /* registry cleanup is best-effort */ }
                            } else {
                                // Transient inspect failure (daemon unreachable /
                                // timeout / permission): do NOT prune. Dropping the
                                // module here would delete a still-live container
                                // from management and let uninstallModule
                                // false-succeed on a hiccup. Keep it visible with an
                                // explicit unknown state so callers act on reality,
                                // not on a mis-inferred 'gone'.
                                nextCoinNetworkModules[nextModule]["status"] = { State: { Status: "unknown" }, NetworkSettings: { Ports: {} } }
                                rows.push({
                                    name:    nextModule,
                                    coin:    nextCoin        || "-",
                                    network: nextCoinNetwork || "-",
                                    branch:  "-",
                                    commit:  "-",
                                    state:   "unknown",
                                    ports:   "-"
                                })
                            }
                        }
                    }

                    for (const mod of toRemove) {
                        delete nextCoinNetworkModules[mod]
                    }
                }

                if (Object.keys(nextCoinNetworkModules).length === 0) {
                    if (nextCoinNetwork === null || nextCoinNetwork === undefined) {
                        delete installedModules[nextCoin][nextCoinNetwork]
                    } else if (nextCoinNetwork === "null") {
                        if ("null" in installedModules && "null" in installedModules["null"]) {
                            delete installedModules["null"]["null"]
                        }
                    } else {
                        delete installedModules[nextCoin][nextCoinNetwork]
                    }
                }
            }

            if (Object.keys(nextCoinNetworks).length === 0) {
                delete installedModules[nextCoin]
            }
        }
    }

    const showBranch = rows.some(r => r.branch !== 'master' && r.branch !== '-')
    // Shown as soon as any container carries a source stamp. Two containers of the
    // same service on different commits is the state this column exists to expose,
    // and it is invisible in every other column: the versions match, the image tags
    // match, and both report healthy.
    const showCommit = rows.some(r => r.commit && r.commit !== '-')
    const COL_COIN    = Math.max("COIN".length,    ...rows.map(r => r.coin.length))    + 2
    const COL_NETWORK = Math.max("NETWORK".length, ...rows.map(r => r.network.length)) + 2
    const COL_NAME    = Math.max("SERVICE".length, ...rows.map(r => r.name.length))    + 2
    const COL_BRANCH  = showBranch ? Math.max("BRANCH".length, ...rows.map(r => r.branch.length)) + 2 : 0
    const COL_COMMIT  = showCommit ? Math.max("COMMIT".length, ...rows.map(r => (r.commit || "-").length)) + 2 : 0
    const COL_STATUS  = Math.max("STATUS".length,  ...rows.map(r => r.state.length))   + 2
    let output = "\x1b[1m"
        + "COIN".padEnd(COL_COIN)
        + "NETWORK".padEnd(COL_NETWORK)
        + "SERVICE".padEnd(COL_NAME)
        + (showBranch ? "BRANCH".padEnd(COL_BRANCH) : "")
        + (showCommit ? "COMMIT".padEnd(COL_COMMIT) : "")
        + "STATUS".padEnd(COL_STATUS)
        + "PORTS\x1b[0m\n"
    for (const row of rows) {
        const color = row.state.startsWith("running") && !row.isChurning ? "\x1b[32m"
            : row.isChurning ? "\x1b[33m"
            : "\x1b[31m"
        output += row.coin.padEnd(COL_COIN)
            + row.network.padEnd(COL_NETWORK)
            + row.name.padEnd(COL_NAME)
            + (showBranch ? row.branch.padEnd(COL_BRANCH) : "")
            + (showCommit ? (row.commit || "-").padEnd(COL_COMMIT) : "")
            + color + row.state.padEnd(COL_STATUS) + "\x1b[0m"
            + row.ports + "\n"
    }
    for (const note of notes) {
        output += "\x1b[33m! " + note + "\x1b[0m\n"
    }
    setLastPrintedStatus(output)
    if (printStatus) console.log(getLastPrintedStatus())

    setLastStatus(installedModules)
    setStatusUpdated(true)
    return installedModules
}

module.exports = {
    statusChanged,
    getStatus,
    loadInstalledModules,
    getInstalledCoinsAndNetworks,
    // Exported for tests
    reduceDecoderReorgHalt,
    describeReorgHaltNote
}
