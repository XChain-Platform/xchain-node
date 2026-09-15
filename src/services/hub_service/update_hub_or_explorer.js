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

const { HUB_MODULE_NAME, EXPLORER_MODULE_NAME, EXTERNAL_DB, XChainService } = require('../../config')
const { db, getLastStatus, isStatusUpdated } = require('../../state')
const { sleep, redactSecrets } = require('../../utils/helpers')
const { getDefaultConfig } = require('../config_service')
const { getStatus } = require('../status_service')
const { getExternalDbConfig } = require('../database_service')
const { readContainerEnv } = require('../db_credential_drift')
const HubConnector = require('../hub_connector.js')
const ExplorerConnector = require('../explorer_connector.js')
const dockerService = require('../docker_service')
const { buildHubModuleConfig, buildCheckpointConfig, isCheckpointSelfSyncEnabled } = require('./hub_module_config.js')
const { getLogger } = require('../../observability/logger');
const logger = getLogger();

const defaultDependencies = {
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, EXTERNAL_DB, XChainService,
    db, getLastStatus, isStatusUpdated, sleep, redactSecrets, getDefaultConfig,
    getStatus, getExternalDbConfig, readContainerEnv, HubConnector,
    ExplorerConnector, dockerService, buildHubModuleConfig, buildCheckpointConfig,
    isCheckpointSelfSyncEnabled, logger
}
let configuredDependencies = null

function configureUpdateHubOrExplorer(dependencies) {
    configuredDependencies = dependencies
}

async function resolveConfigContext(dependencies) {
    const { EXTERNAL_DB, getExternalDbConfig, isCheckpointSelfSyncEnabled, readContainerEnv } = dependencies
    // Resolved once, outside the loops: in external-DB mode the module-config view
    // must report the host/port the pool actually opened against, which comes from
    // getExternalDbConfig() (env → saved credentials.json), not the load-time
    // EXTERNAL_DB_HOST/PORT constants. Those default to 127.0.0.1:3306, so a host
    // saved at the first-run prompt would be misreported to the hub.
    const externalDbCfg = EXTERNAL_DB ? await getExternalDbConfig() : null

    // Resolved once per push, for the same reason: the answer is a property of the
    // deployment, not of the coin/network being emitted, so every installed coin gets
    // the same verdict and none is silently left without a checkpoint block.
    const checkpointSelfSync = await isCheckpointSelfSyncEnabled({ readContainerEnv })

    return { externalDbCfg, checkpointSelfSync }
}

function createModuleConnector(module, defaultConfig, dependencies) {
    const { HUB_MODULE_NAME, HubConnector, ExplorerConnector } = dependencies
    if (module === HUB_MODULE_NAME) {
        return new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])
    }
    return new ExplorerConnector("127.0.0.1", defaultConfig["EXPLORER_PORT"])
}

async function buildConfigPayload(module, lastStatus, context, dependencies) {
    const { EXTERNAL_DB, XChainService, getDefaultConfig, buildHubModuleConfig, buildCheckpointConfig } = dependencies
    const { externalDbCfg, checkpointSelfSync } = context
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
                const config = buildHubModuleConfig(nextModule, defaultConfigCoinNetwork, { EXTERNAL_DB, externalDbCfg })

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

            // Advertise a self-synced checkpoint schema for this coin/
            // network once an indexer is actually installed for it (the
            // checkpoint config needs the indexer's own DB host/port/user/pass)
            // and the operator opted in (once, at any point in this deployment's
            // life: see isCheckpointSelfSyncEnabled). See buildCheckpointConfig above.
            if (checkpointSelfSync && XChainService.XCHAIN_INDEXER in lastStatus[nextCoin][nextNetwork]) {
                const checkpointConfig = buildCheckpointConfig(defaultConfigCoinNetwork)
                if (module === "xchain-explorer") {
                    nextConfigObject.checkpoint = checkpointConfig
                } else {
                    if (!(nextCoin in jsonConfig)) jsonConfig[nextCoin] = {}
                    if (!(nextNetwork in jsonConfig[nextCoin])) jsonConfig[nextCoin][nextNetwork] = {}
                    jsonConfig[nextCoin][nextNetwork].checkpoint = checkpointConfig
                }
            }
        }
    }

    return jsonConfig
}

async function writeExplorerConfig(module, jsonConfig, dependencies) {
    const { db, EXPLORER_MODULE_NAME, dockerService } = dependencies
    const explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")
    // getModuleContainer returns null on a registry miss rather than
    // throwing, so an uninstalled explorer is refused here by name. Passed
    // on to stringToDockerContainerFile(null, ...) it would surface as the
    // same generic "problem trying to update a config" error as a real
    // failure, masking the actual cause.
    if (!explorerContainerId) {
        throw "xchain-explorer module is not installed; cannot update its config"
    }
    try {
        const { stringToDockerContainerFile } = dockerService
        await stringToDockerContainerFile(explorerContainerId, JSON.stringify(jsonConfig), "/XChainExplorer/src/config.json")
    } catch {
        throw "There was a problem trying to update a config in the " + module + " module"
    }
}

async function pushHubConfig(module, moduleConnector, jsonConfig, dependencies) {
    const { sleep, redactSecrets, logger } = dependencies
    let hubUpdated = false
    let tries = 10
    // Keep the last failure. updateConfig is an HTTP call to the module's own
    // API, so when the container is crash-looping every attempt fails with a
    // connection error and this loop reports only "there was a problem" - which
    // hides the fact that the CONFIG is fine and the SERVICE never came up. That
    // misdirection cost real debugging time: the true cause was in the
    // container's own log, not here.
    let lastErr = null
    while (!hubUpdated) {
        try {
            hubUpdated = await moduleConnector.updateConfig(jsonConfig)
        } catch (err) { lastErr = err }

        // A FALSY RETURN is a failure too, and it was the one reported with no
        // cause at all. callRpc() catches its own transport errors and returns
        // null, so a 401 from a key-enforcing hub never reaches the catch above
        // and lastErr stays null - which is precisely the case that printed
        // "There was a problem trying to update a config" and nothing else, on
        // the single most informative fact about the failure. The connector
        // already records why each endpoint failed, for exactly this purpose.
        if (!hubUpdated && !lastErr
            && Array.isArray(moduleConnector.lastFailures)
            && moduleConnector.lastFailures.length) {
            lastErr = moduleConnector.lastFailures.join('; ')
        }

        tries--
        // Out of retries: give up, naming the last concrete error instead of a generic failure.
        if (tries <= 0) {
            throw "There was a problem trying to update a config in the " + module + " module" +
                (lastErr ? " (last error: " + redactSecrets(lastErr) + "; if this is a connection failure, check `docker logs` for the module - the service is not starting)" : "")
        }
        if (!hubUpdated) {
            logger.info("There was a problem trying to update a config in the " + module + " module" +
                (lastErr ? " (" + redactSecrets(lastErr) + ")" : "") + ". Trying again in 3 seconds...")
            await sleep(3000)
        }
    }
}

async function updateHubOrExplorer(module, dependencies = configuredDependencies || defaultDependencies) {
    const { HUB_MODULE_NAME, EXPLORER_MODULE_NAME, getDefaultConfig, getStatus, isStatusUpdated, getLastStatus } = dependencies
    // Only the hub and the explorer accept a pushed config; refuse anything else before a connector is built.
    if (![HUB_MODULE_NAME, EXPLORER_MODULE_NAME].includes(module)) {
        throw "Only the xchain-hub or the xchain-explorer could be updated"
    }

    const defaultConfig = await getDefaultConfig(module, null, null)
    const moduleConnector = createModuleConnector(module, defaultConfig, dependencies)

    await getStatus(null, null, false)

    // The pushed config is built from live container status, so refuse to push from a status that did not refresh.
    if (!isStatusUpdated()) {
        throw "The status is not updated"
    }

    const lastStatus = getLastStatus()
    const context = await resolveConfigContext(dependencies)
    const jsonConfig = await buildConfigPayload(module, lastStatus, context, dependencies)

    if (module === "xchain-explorer") {
        await writeExplorerConfig(module, jsonConfig, dependencies)
    } else {
        await pushHubConfig(module, moduleConnector, jsonConfig, dependencies)
    }

    return true
}

module.exports = { updateHubOrExplorer, configureUpdateHubOrExplorer }
