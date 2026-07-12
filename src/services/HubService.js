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
 * XChain Node - Hub Service
 * Install and configure the xchain-hub module
 ********************************************************************/

const {
    HUB_MODULE_NAME, DB_MODULE_NAME, NODE_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    XChainService, SEP,
    EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT
} = require('../config/constants')
const { db, getLastStatus, isStatusUpdated, isVerbose } = require('../state')
const { sleep }                                = require('../utils/helpers')
const { getDefaultConfig, getDockerContainerImageName, getDockerNetwork } = require('./ConfigService')
const { statusChanged, getStatus, getInstalledCoinsAndNetworks } = require('./StatusService')
const { addContainerToNetwork }                = require('./DockerService')
const { cloneGit, buildAndUp }                 = require('./ModuleService')
const { addUserPasswordToDatabase }            = require('./DatabaseService')
const HubConnector                             = require('../HubConnector.js')

async function updateHubOrExplorer(module) {
    if (![HUB_MODULE_NAME, EXPLORER_MODULE_NAME].includes(module)) {
        throw "Only the xchain-hub or the xchain-explorer could be updated"
    }

    const defaultConfig = await getDefaultConfig(module, null, null)
    let moduleConnector = null

    if (module === HUB_MODULE_NAME) {
        moduleConnector = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])
    } else {
        const ExplorerConnector = require('../ExplorerConnector.js')
        moduleConnector = new ExplorerConnector("127.0.0.1", defaultConfig["EXPLORER_PORT"])
    }

    await getStatus(null, null, false)

    if (!isStatusUpdated()) {
        throw "The status is not updated"
    }

    const lastStatus = getLastStatus()
    let jsonConfig = {}

    if (module === "xchain-explorer") {
        jsonConfig["configs"] = []
        jsonConfig = jsonConfig["configs"]
    }

    for (const nextCoin in lastStatus) {
        for (const nextNetwork in lastStatus[nextCoin]) {
            const defaultConfigCoinNetwork = await getDefaultConfig("", nextCoin, nextNetwork)
            let nextConfigObject = null

            if (module === "xchain-explorer") {
                nextConfigObject = { "coin": nextCoin, "network": nextNetwork }
                jsonConfig.push(nextConfigObject)
            }

            for (const nextModule in lastStatus[nextCoin][nextNetwork]) {
                let config = null

                switch (nextModule) {
                    case DB_MODULE_NAME:
                        // External DB has no container; point the hub at the
                        // configured external host so its module-config view
                        // reflects reality.
                        config = EXTERNAL_DB
                            ? { "host": EXTERNAL_DB_HOST, "port": EXTERNAL_DB_PORT }
                            : { "host": "mariadb", "port": 3306 }
                        break
                    case NODE_MODULE_NAME:
                        config = {
                            "host":        defaultConfigCoinNetwork["NODE_URL"],
                            "port":        defaultConfigCoinNetwork["NODE_PORT"],
                            "server_port": defaultConfigCoinNetwork["NODE_EXPOSED_PORT"],
                            "user":        defaultConfigCoinNetwork["NODE_USER"],
                            "pass":        defaultConfigCoinNetwork["NODE_PASSWORD"]
                        }
                        break
                    case XChainService.XCHAIN_DECODER:
                        config = {
                            "host":        defaultConfigCoinNetwork["DECODER_URL"],
                            "port":        defaultConfigCoinNetwork["DECODER_API_PORT"],
                            "server_port": defaultConfigCoinNetwork["DECODER_PORT"],
                            "db_host":     defaultConfigCoinNetwork["DECODER_DB_HOST"],
                            "db_port":     defaultConfigCoinNetwork["DECODER_DB_PORT"],
                            "name":        defaultConfigCoinNetwork["DECODER_DB_NAME"],
                            "user":        defaultConfigCoinNetwork["DECODER_DB_USER"],
                            "pass":        defaultConfigCoinNetwork["DECODER_DB_PASS"]
                        }
                        break
                    case XChainService.XCHAIN_ENCODER:
                        config = {
                            "host":        defaultConfigCoinNetwork["ENCODER_URL"],
                            "port":        defaultConfigCoinNetwork["ENCODER_API_PORT"],
                            "server_port": defaultConfigCoinNetwork["ENCODER_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_INDEXER:
                        config = {
                            "host":        defaultConfigCoinNetwork["INDEXER_URL"],
                            "port":        defaultConfigCoinNetwork["INDEXER_API_PORT"],
                            "server_port": defaultConfigCoinNetwork["INDEXER_PORT"],
                            "db_host":     defaultConfigCoinNetwork["INDEXER_DB_HOST"],
                            "db_port":     defaultConfigCoinNetwork["INDEXER_DB_PORT"],
                            "name":        defaultConfigCoinNetwork["INDEXER_DB_NAME"],
                            "user":        defaultConfigCoinNetwork["INDEXER_DB_USER"],
                            "pass":        defaultConfigCoinNetwork["INDEXER_DB_PASS"]
                        }
                        break
                    case XChainService.XCHAIN_UTXO_TRACKER:
                        config = {
                            "host":        defaultConfigCoinNetwork["UTXO_TRACKER_URL"],
                            "port":        defaultConfigCoinNetwork["UTXO_TRACKER_API_PORT"],
                            "server_port": defaultConfigCoinNetwork["UTXO_TRACKER_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_REGTEST_MINER:
                        config = {
                            "host":        defaultConfigCoinNetwork["REGTEST_MINER_URL"],
                            "port":        defaultConfigCoinNetwork["REGTEST_MINER_API_PORT"],
                            "server_port": defaultConfigCoinNetwork["REGTEST_MINER_PORT"]
                        }
                        break
                }

                if (config != null) {
                    if (module === "xchain-explorer") {
                        nextConfigObject[nextModule] = config
                    } else {
                        if (!(nextCoin in jsonConfig)) jsonConfig[nextCoin] = {}
                        if (!(nextNetwork in jsonConfig[nextCoin])) jsonConfig[nextCoin][nextNetwork] = {}
                        jsonConfig[nextCoin][nextNetwork][nextModule] = config
                    }
                }
            }
        }
    }

    if (module === "xchain-explorer") {
        const explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")
        // getModuleContainer returns null on a registry miss rather than
        // throwing, so an uninstalled explorer previously fell through into
        // stringToDockerContainerFile(null, ...) and surfaced as the same
        // generic "problem trying to update a config" error as a real
        // failure, masking the actual cause (uuid:fd7cc224 sibling site).
        if (!explorerContainerId) {
            throw "xchain-explorer module is not installed; cannot update its config"
        }
        try {
            const { stringToDockerContainerFile } = require('./DockerService')
            await stringToDockerContainerFile(explorerContainerId, JSON.stringify(jsonConfig), "/XChainExplorer/src/config.json")
        } catch {
            throw "There was a problem trying to update a config in the " + module + " module"
        }
    } else {
        let hubUpdated = false
        let tries = 10
        while (!hubUpdated) {
            try {
                hubUpdated = await moduleConnector.updateConfig(jsonConfig)
            } catch { /* retry */ }

            tries--
            if (tries <= 0) {
                throw "There was a problem trying to update a config in the " + module + " module"
            }
            if (!hubUpdated) {
                console.log("There was a problem trying to update a config in the " + module + " module. Trying again in 3 seconds...")
                await sleep(3000)
            }
        }
    }

    return true
}

async function updateHub() {
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const hubContainerId = await db.getModuleContainer(HUB_MODULE_NAME, "", "")

    if (hubContainerId) {
        for (const nextCoin in installedCoinsAndNetworks) {
            for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
                try {
                    await addContainerToNetwork(hubContainerId, getDockerNetwork(nextCoin, nextNetwork))
                } catch {
                    console.log("There was an error trying to connect the xchain-hub to the " + nextCoin + "/" + nextNetwork + " network")
                }
            }
        }
        await updateHubOrExplorer(HUB_MODULE_NAME)
    }

    // Connect xchain-sync container to all chain/network Docker networks (same pattern as hub)
    const syncContainerId = await db.getModuleContainer(SYNC_MODULE_NAME, "", "")
    if (syncContainerId) {
        for (const nextCoin in installedCoinsAndNetworks) {
            for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
                try {
                    await addContainerToNetwork(syncContainerId, getDockerNetwork(nextCoin, nextNetwork))
                } catch {
                    console.log("There was an error trying to connect xchain-sync to the " + nextCoin + "/" + nextNetwork + " network")
                }
            }
        }
    }

    return true
}

async function installHubModule() {
    const defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    if (isVerbose()) console.log("Checking if xchain-hub module is running")
    const hubConnector = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])

    const pingHub = await hubConnector.ping()
    if (pingHub) return true

    console.log("Checking if xchain-hub module is installed")
    if (isStatusUpdated()) {
        const lastStatus = getLastStatus()
        const hubStatus = lastStatus?.[""]?.[""]?.[HUB_MODULE_NAME]

        if (hubStatus !== undefined) {
            if (hubStatus["status"]["State"]["Status"] === "exited") {
                console.log("The hub module container status is 'exited'. Restarting it...")
                const { restartContainer } = require('./DockerService')
                const restarted = await restartContainer(hubStatus["container_id"])
                if (restarted !== true) {
                    throw false
                }
                console.log("Waiting for the xchain-hub to respond")
                let restartTries = 10
                while (restartTries > 0) {
                    const ping = await hubConnector.ping()
                    if (ping) break
                    restartTries--
                    await sleep(2000)
                }
            }
            return true
        }
    }

    console.log("Downloading xchain-hub...")
    await cloneGit(HUB_MODULE_NAME, true)

    await addUserPasswordToDatabase(
        HUB_MODULE_NAME, "", "",
        defaultConfig["HUB_DB_NAME"], defaultConfig["HUB_DB_USER"], defaultConfig["HUB_DB_PASS"]
    )

    console.log("Installing xchain-hub module...")
    await buildAndUp(HUB_MODULE_NAME, null, null)
    await getStatus(null, null, false)
    console.log("Waiting for the xchain-hub to respond")

    let tries = 10
    while (tries > 0) {
        const ping = await hubConnector.ping()
        if (ping) {
            await updateHub()
            return true
        }
        tries--
        await sleep(2000)
    }

    throw "Couldn't install hub module"
}

module.exports = {
    updateHubOrExplorer,
    updateHub,
    installHubModule
}
