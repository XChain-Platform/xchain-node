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

let path = require('path')
let { NODE_MODULE_NAME, SEP, XChainService } = require('../../config')
let {
    db, getInstalledModules, resetInstalledModules, getRemoteModuleVersions,
    isStatusUpdated, setStatusUpdated, getLastStatus, setLastStatus,
    getLastPrintedStatus, setLastPrintedStatus
} = require('../../state')
let { getStatusFromContainer } = require('../docker_service')
let { getLocalNodeVersion, getContainerNodeVersion, getLocalModuleVersion, getContainerModuleVersion } = require('../version_service')
// The peer table names files beside src/services, one directory up from this part.
let peers = require('../peer_services').bindPeerServices((file) => require(path.join('..', file)))
let { getLogger } = require('../../observability/logger');
let logger = getLogger();
let { checkRemoteNodeVersionAdvisory, loadInstalledModules } = require('./installed_modules')
let {
    isContainerGoneError, probeServiceHealthPayload,
    reduceNodeCatchingUp, describeNodeCatchingUpNote,
    reduceNodeUnreachable, describeNodeUnreachableNote,
    reduceDecoderReorgHalt, describeReorgHaltNote,
    reduceIndexerStall, describeIndexerStallNote,
    reduceTrackerHalt, describeTrackerHaltNote
} = require('./status_reducers')

function configureDependencies(dependencies) {
    ;({ NODE_MODULE_NAME, SEP, XChainService, db, getInstalledModules, resetInstalledModules, getRemoteModuleVersions, isStatusUpdated, setStatusUpdated, getLastStatus, setLastStatus, getLastPrintedStatus, setLastPrintedStatus, getStatusFromContainer, getLocalNodeVersion, getContainerNodeVersion, getLocalModuleVersion, getContainerModuleVersion, peers, getLogger, logger, checkRemoteNodeVersionAdvisory, loadInstalledModules, isContainerGoneError, probeServiceHealthPayload, reduceNodeCatchingUp, describeNodeCatchingUpNote, reduceNodeUnreachable, describeNodeUnreachableNote, reduceDecoderReorgHalt, describeReorgHaltNote, reduceIndexerStall, describeIndexerStallNote, reduceTrackerHalt, describeTrackerHaltNote } = dependencies)
}

async function recordVersions(moduleStatus, nextModule, nextCoin, nextCoinNetwork, containerId, remoteModuleVersions) {
    let remoteVersion = "-"
    try {
        if (nextModule === NODE_MODULE_NAME) {
            remoteVersion = remoteModuleVersions[nextModule + SEP + nextCoin]["tag_name"].substring(1)
        } else {
            remoteVersion = remoteModuleVersions[nextModule]
        }
        moduleStatus["remote_version"] = remoteVersion
    } catch { /* not available yet */ }

    let localVersion = "-"
    try {
        if (nextModule === NODE_MODULE_NAME) {
            localVersion = await getLocalNodeVersion(nextCoin, nextCoinNetwork)
        } else {
            localVersion = await getLocalModuleVersion(nextModule)
        }
        moduleStatus["local_version"] = localVersion
    } catch { /* not available yet */ }

    let containerVersion = "-"
    try {
        if (nextModule === NODE_MODULE_NAME) {
            containerVersion = await getContainerNodeVersion(nextCoin, nextCoinNetwork, containerId)
        } else {
            containerVersion = await getContainerModuleVersion(nextModule, nextCoin, nextCoinNetwork, containerId)
        }
        moduleStatus["container_version"] = containerVersion
    } catch { /* not available yet */ }
}

async function readModuleBranch(nextModule) {
    let branch = "-"
    if (nextModule !== NODE_MODULE_NAME) {
        const { getModuleBranch } = peers.moduleService
        try { branch = await getModuleBranch(nextModule) } catch { /* not available */ }
    }
    return branch
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
function readContainerCommit(containerStatus) {
    let commit = "-"
    try {
        const labels = containerStatus["Config"]["Labels"] || {}
        const stamped = labels["xchain.source.commit"]
        if (typeof stamped === "string" && /^[a-f0-9]{40}$/.test(stamped)) {
            commit = stamped.slice(0, 12)
        }
    } catch { /* no Config/Labels on this inspect payload */ }
    return commit
}

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
function describeContainerState(containerStatus) {
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
    return { state, isChurning }
}

// A decoder carrying a durable REORG_HALT marker keeps parsing
// and reports a healthy healthcheck (api.js keeps the marker off
// the healthcheck on purpose: autoheal would restart-loop a
// service that is doing useful work), so nothing above shows
// it. The decoder's own health surface does. Read it here for
// running decoders, advisory only: a probe that fails changes
// nothing, and the note under the table names the recovery.
//
// The same surface says when a decoder or tracker is waiting
// out a coin node still in initial block download below its
// own tip (a bootstrap restored next to a fresh node): the
// container is healthy and idle, which without this line
// reads as a service that has stopped following the chain.
//
// The indexer's surface carries its stall (`stallReason`) and
// the tracker's carries its halt (`halted`), and neither
// reaches docker: a BTC indexer deferring every block for want
// of a DOGE read, or a tracker halted on a reorg past its undo
// window, kept a healthy node, a healthy decoder and a clean
// `ps` for days. Same posture as the decoder's marker: read
// for running containers, advisory, note names the remedy.
async function annotatePublishedHealth(nextModule, containerId, nextCoin, nextCoinNetwork, containerStatus, moduleStatus, notes, display) {
    const probesHealthSurface = nextModule === XChainService.XCHAIN_DECODER
        || nextModule === XChainService.XCHAIN_UTXO_TRACKER
        || nextModule === XChainService.XCHAIN_INDEXER
    if (!probesHealthSurface || containerStatus["State"]["Status"] !== "running") return display
    let payload = null
    try {
        payload = await probeServiceHealthPayload(nextModule, containerId, nextCoin, nextCoinNetwork)
    } catch { /* advisory: an unreadable surface is not a halt */ }
    const findings = [
        [nextModule === XChainService.XCHAIN_DECODER ? reduceDecoderReorgHalt(payload) : null,
            "reorg_halt", " REORG_HALT", describeReorgHaltNote],
        [nextModule === XChainService.XCHAIN_INDEXER ? reduceIndexerStall(payload) : null,
            "stall", null, describeIndexerStallNote],
        [nextModule === XChainService.XCHAIN_UTXO_TRACKER ? reduceTrackerHalt(payload) : null,
            "halt", " HALTED", describeTrackerHaltNote]
    ]
    for (const [finding, key, suffix, describe] of findings) {
        if (finding && (finding.halted || finding.stalled)) {
            display.state += suffix || " STALL " + finding.word
            display.isChurning = true
            moduleStatus[key] = finding
            notes.push(describe(nextCoin, nextCoinNetwork, finding))
        }
    }
    const wait = reduceNodeCatchingUp(payload)
    if (wait) {
        display.state += " WAITING FOR NODE"
        display.isChurning = true
        moduleStatus["node_catching_up"] = wait
        notes.push(describeNodeCatchingUpNote(nextCoin, nextCoinNetwork, nextModule, wait))
    }
    const gap = reduceNodeUnreachable(payload)
    if (gap) {
        display.state += " NODE UNREACHABLE"
        display.isChurning = true
        moduleStatus["node_unreachable"] = gap
        notes.push(describeNodeUnreachableNote(nextCoin, nextCoinNetwork, nextModule, gap))
    }
    return display
}

function readPublishedPorts(containerStatus) {
    const rawPorts = containerStatus["NetworkSettings"]["Ports"] || {}
    const portParts = []
    for (const [containerPort, bindings] of Object.entries(rawPorts)) {
        if (bindings && bindings.length > 0) {
            for (const binding of bindings) {
                portParts.push(binding.HostIp + ":" + binding.HostPort + "->" + containerPort)
            }
        }
    }
    return portParts.length > 0 ? portParts.join(", ") : "-"
}

async function recordContainerFailure(err, nextModule, nextCoin, nextCoinNetwork, moduleStatus, toRemove, rows) {
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
            await db.deleteModuleContainer(nextModule, nextCoin, nextCoinNetwork)
        } catch { /* registry cleanup is best-effort */ }
        return
    }
    // Transient inspect failure (daemon unreachable /
    // timeout / permission): do NOT prune. Dropping the
    // module here would delete a still-live container
    // from management and let uninstallModule
    // false-succeed on a hiccup. Keep it visible with an
    // explicit unknown state so callers act on reality,
    // not on a mis-inferred 'gone'.
    moduleStatus["status"] = { State: { Status: "unknown" }, NetworkSettings: { Ports: {} } }
    rows.push({ name: nextModule, coin: nextCoin || "-", network: nextCoinNetwork || "-",
        branch: "-", commit: "-", state: "unknown", ports: "-" })
}

async function inspectModule(nextModule, nextCoin, nextCoinNetwork, nextCoinNetworkModules, remoteModuleVersions, notes, toRemove, rows) {
    const moduleStatus = nextCoinNetworkModules[nextModule]
    const containerId = moduleStatus["container_id"]
    try {
        const containerStatus = await getStatusFromContainer(containerId)
        moduleStatus["status"] = containerStatus
        await recordVersions(moduleStatus, nextModule, nextCoin, nextCoinNetwork, containerId, remoteModuleVersions)
        const branch = await readModuleBranch(nextModule)
        const commit = readContainerCommit(containerStatus)
        const display = await annotatePublishedHealth(nextModule, containerId, nextCoin, nextCoinNetwork,
            containerStatus, moduleStatus, notes, describeContainerState(containerStatus))
        rows.push({ name: nextModule, coin: nextCoin || "-", network: nextCoinNetwork || "-", branch, commit,
            state: display.state, isChurning: display.isChurning, ports: readPublishedPorts(containerStatus) })
    } catch (err) {
        await recordContainerFailure(err, nextModule, nextCoin, nextCoinNetwork, moduleStatus, toRemove, rows)
    }
}

async function collectStatusRows(installedModules, remoteModuleVersions, checkVersions, notes) {
    const rows = []
    for (const nextCoin in installedModules) {
        if (checkVersions && !(NODE_MODULE_NAME + SEP + nextCoin in remoteModuleVersions)) {
            await checkRemoteNodeVersionAdvisory(nextCoin)
        }
        const nextCoinNetworks = installedModules[nextCoin]
        for (const nextCoinNetwork in nextCoinNetworks) {
            const nextCoinNetworkModules = installedModules[nextCoin][nextCoinNetwork]
            const toRemove = []
            for (const nextModule in nextCoinNetworkModules) {
                await inspectModule(nextModule, nextCoin, nextCoinNetwork, nextCoinNetworkModules,
                    remoteModuleVersions, notes, toRemove, rows)
            }
            for (const mod of toRemove) delete nextCoinNetworkModules[mod]
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
        if (Object.keys(nextCoinNetworks).length === 0) delete installedModules[nextCoin]
    }
    return rows
}

function renderStatusTable(rows, notes) {
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
    return output
}

async function getStatus(coin, network, printStatus = false, checkVersions = false) {
    if (isStatusUpdated()) {
        if (printStatus) logger.info(getLastPrintedStatus())
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
    // Lines printed under the table for states a column cannot explain.
    const notes = []
    const rows = await collectStatusRows(installedModules, remoteModuleVersions, checkVersions, notes)
    const output = renderStatusTable(rows, notes)
    setLastPrintedStatus(output)
    if (printStatus) logger.info(getLastPrintedStatus())

    setLastStatus(installedModules)
    setStatusUpdated(true)
    return installedModules
}

module.exports = { getStatus, configureDependencies }
