/*********************************************************************
 * XChain Node - Status Service
 * Tracks installed modules and container status
 ********************************************************************/

const {
    NODE_MODULE_NAME, SEP, Coin, Network
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
const { getModuleBranch } = require('./ModuleService')

async function statusChanged() {
    setStatusUpdated(false)
    // Lazy requires to avoid circular dependency
    const { updateHub }      = require('./HubService')
    const { updateExplorer } = require('./ExplorerService')
    await updateHub()
    await updateExplorer()
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

async function getStatus(coin, network, printStatus = false, checkVersions = false) {
    if (isStatusUpdated()) {
        if (printStatus) console.log(getLastPrintedStatus())
        return getLastStatus()
    }

    setLastPrintedStatus("")
    resetInstalledModules()
    await loadInstalledModules(coin, network, checkVersions)

    const installedModules = getInstalledModules()
    const remoteModuleVersions = getRemoteModuleVersions()

    const rows = []

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
                                try { branch = await getModuleBranch(nextModule) } catch { /* not available */ }
                            }

                            const state       = containerStatus["State"]["Status"]
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
                                state,
                                ports: portParts.length > 0 ? portParts.join(", ") : "-"
                            })

                        } catch {
                            toRemove.push(nextModule)
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
    const COL_COIN    = Math.max("COIN".length,    ...rows.map(r => r.coin.length))    + 2
    const COL_NETWORK = Math.max("NETWORK".length, ...rows.map(r => r.network.length)) + 2
    const COL_NAME    = Math.max("SERVICE".length, ...rows.map(r => r.name.length))    + 2
    const COL_BRANCH  = showBranch ? Math.max("BRANCH".length, ...rows.map(r => r.branch.length)) + 2 : 0
    const COL_STATUS  = Math.max("STATUS".length,  ...rows.map(r => r.state.length))   + 2
    let output = "\x1b[1m"
        + "COIN".padEnd(COL_COIN)
        + "NETWORK".padEnd(COL_NETWORK)
        + "SERVICE".padEnd(COL_NAME)
        + (showBranch ? "BRANCH".padEnd(COL_BRANCH) : "")
        + "STATUS".padEnd(COL_STATUS)
        + "PORTS\x1b[0m\n"
    for (const row of rows) {
        const color = row.state === "running" ? "\x1b[32m" : "\x1b[31m"
        output += row.coin.padEnd(COL_COIN)
            + row.network.padEnd(COL_NETWORK)
            + row.name.padEnd(COL_NAME)
            + (showBranch ? row.branch.padEnd(COL_BRANCH) : "")
            + color + row.state.padEnd(COL_STATUS) + "\x1b[0m"
            + row.ports + "\n"
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
    getInstalledCoinsAndNetworks
}
