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
async function probeServiceHealthPayload(module, containerId, coin, network) {
    const { probeServiceStatus, MODULE_API_PORT_KEY } = require('./BootstrapHealthGate')
    const { getDefaultConfig } = require('./ConfigService')
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const runner = (cmd, args) => promisify(execFile)(cmd, args, { timeout: 15000 })
    const config = await getDefaultConfig(module, coin, network)
    const port = config && config[MODULE_API_PORT_KEY[module]]
    if (!port) return null
    return probeServiceStatus(containerId, port, runner)
}

async function probeDecoderReorgHalt(containerId, coin, network) {
    return reduceDecoderReorgHalt(await probeServiceHealthPayload(XChainService.XCHAIN_DECODER, containerId, coin, network))
}

// The wait a decoder or tracker publishes while its coin node is still in
// initial block download below the service's own tip (`node_catching_up`,
// see the decoder and tracker IBD wait), or null when the service is not waiting or the payload
// predates the field. Strict on shape: an object with a numeric node height.
function reduceNodeCatchingUp(payload) {
    if (!payload || typeof payload !== 'object') return null
    const wait = payload.node_catching_up
    if (!wait || typeof wait !== 'object') return null
    const nodeHeight   = Number(wait.node_height)
    const storedHeight = Number(wait.stored_height)
    if (!Number.isFinite(nodeHeight)) return null
    return {
        node_height:   nodeHeight,
        stored_height: Number.isFinite(storedHeight) ? storedHeight : null,
        since:         wait.since || null
    }
}

// The line `ps` prints under the table for a service waiting on its node:
// what it is waiting for, how far the node has to go, and that it is not stuck.
function describeNodeCatchingUpNote(coin, network, module, wait) {
    const gap = (wait.stored_height !== null && Number.isFinite(wait.stored_height))
        ? " (" + Math.max(0, wait.stored_height - wait.node_height) + " blocks to go)" : ""
    return coin + "/" + network + " " + module + " is WAITING FOR NODE"
        + (wait.since ? " since " + wait.since : "")
        + ": the coin node is at " + wait.node_height + ", still in initial block download below the service's "
        + (wait.stored_height !== null ? "stored height " + wait.stored_height : "stored height") + gap
        + ". This is expected after a bootstrap restore next to a fresh node; the service continues on its own once the node passes it."
}

// The stretch a decoder or tracker publishes while its most recent call to the
// coin node failed (`node_unreachable`, alongside `node_last_ok_at`), or null
// when the node answered last, the service has not called it yet, or the
// payload predates the field. Distinct from WAITING FOR NODE on purpose: a
// waiting service has an answer from its node and is idle by choice, an
// unreachable one has no answer at all. A decoder on a slow host once sat
// five and a half days in this state and every surface read healthy, because
// the docker healthcheck, correctly, does not fail on an outage a restart
// cannot fix. Strict on shape: an object with a `since` string.
function reduceNodeUnreachable(payload) {
    if (!payload || typeof payload !== 'object') return null
    const gap = payload.node_unreachable
    if (!gap || typeof gap !== 'object' || typeof gap.since !== 'string' || !gap.since) return null
    const seconds = Number(gap.seconds)
    return {
        since:      gap.since,
        last_ok_at: typeof gap.last_ok_at === 'string' && gap.last_ok_at ? gap.last_ok_at : null,
        seconds:    Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null
    }
}

// "3d 4h", "2h 05m", "45s": what an operator scans for, not a raw second count.
function describeDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return d + "d " + h + "h"
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m"
    if (m > 0) return m + "m"
    return Math.floor(seconds) + "s"
}

// The line `ps` prints under the table for a service whose node is not
// answering: since when, whether it ever answered, and what to look at. Says
// explicitly that this is not the IBD wait, because from outside the two look
// the same (a healthy, idle container).
function describeNodeUnreachableNote(coin, network, module, gap) {
    const forHowLong = describeDuration(gap.seconds)
    return coin + "/" + network + " " + module + " cannot reach its coin node"
        + (forHowLong ? " (" + forHowLong + ", since " + gap.since + ")" : " (since " + gap.since + ")")
        + (gap.last_ok_at ? ": the last answer was at " + gap.last_ok_at + "." : ": it has NEVER had an answer from the node.")
        + " This is not the initial-block-download wait; the service has no answer to wait on."
        + " Check that the " + coin + " " + network + " node container is running and answering RPC"
        + " (a node mid-sync on slow hardware can time out every call for days), and its logs.";
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
                            //
                            // The same surface says when a decoder or tracker is waiting
                            // out a coin node still in initial block download below its
                            // own tip (a bootstrap restored next to a fresh node): the
                            // container is healthy and idle, which without this line
                            // reads as a service that has stopped following the chain.
                            const probesHealthSurface = nextModule === XChainService.XCHAIN_DECODER
                                || nextModule === XChainService.XCHAIN_UTXO_TRACKER
                            if (probesHealthSurface && containerStatus["State"]["Status"] === "running") {
                                let payload = null
                                try {
                                    payload = await probeServiceHealthPayload(nextModule, containerId, nextCoin, nextCoinNetwork)
                                } catch { /* advisory: an unreadable surface is not a halt */ }
                                const reorgHalt = nextModule === XChainService.XCHAIN_DECODER ? reduceDecoderReorgHalt(payload) : null
                                if (reorgHalt && reorgHalt.halted) {
                                    state += " REORG_HALT"
                                    isChurning = true
                                    nextCoinNetworkModules[nextModule]["reorg_halt"] = reorgHalt
                                    notes.push(describeReorgHaltNote(nextCoin, nextCoinNetwork, reorgHalt))
                                }
                                const wait = reduceNodeCatchingUp(payload)
                                if (wait) {
                                    state += " WAITING FOR NODE"
                                    isChurning = true
                                    nextCoinNetworkModules[nextModule]["node_catching_up"] = wait
                                    notes.push(describeNodeCatchingUpNote(nextCoin, nextCoinNetwork, nextModule, wait))
                                }
                                // A node that is not answering at all, which the same
                                // healthy-and-idle container hides: the service has no
                                // tip to wait on, so it is neither waiting nor stalled.
                                const gap = reduceNodeUnreachable(payload)
                                if (gap) {
                                    state += " NODE UNREACHABLE"
                                    isChurning = true
                                    nextCoinNetworkModules[nextModule]["node_unreachable"] = gap
                                    notes.push(describeNodeUnreachableNote(nextCoin, nextCoinNetwork, nextModule, gap))
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
    describeReorgHaltNote,
    reduceNodeCatchingUp,
    describeNodeCatchingUpNote,
    reduceNodeUnreachable,
    describeNodeUnreachableNote,
    describeDuration
}
