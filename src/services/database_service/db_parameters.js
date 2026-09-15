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


let { execFile } = require('child_process')
let { HUB_MODULE_NAME, XChainService, EXTERNAL_DB } = require('../../config')
let { db } = require('../../state')
let { getDefaultConfig, getDockerContainerImageName, getDockerNetwork } = require('../config_service')
let { addContainerToNetwork } = require('../docker_service')
let { assertNoDbCredentialDrift, assertNoHubDbCredentialDrift, isDbCredentialDriftError } = require('../db_credential_drift')
let statusService = require('../status_service')
let { statusChanged } = statusService
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { getDatabaseContainerId } = require('./container_access')
let { addUserPasswordToDatabase } = require('./user_provisioning')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, HUB_MODULE_NAME, XChainService, EXTERNAL_DB, db, getDefaultConfig, getDockerContainerImageName, getDockerNetwork, addContainerToNetwork, assertNoDbCredentialDrift, assertNoHubDbCredentialDrift, isDbCredentialDriftError, statusService, statusChanged, getLogger, logger } = dependencies)
}

async function provisionDatabaseAccount(nextCoin, nextNetwork, dbContainerId) {
    let accountsProvisioned = 0
            try {
                // External DB has no container to attach to per-coin networks;
                // it's reachable via the bridge gateway from inside containers.
                if (!EXTERNAL_DB) {
                    await addContainerToNetwork(dbContainerId, getDockerNetwork(nextCoin, nextNetwork))
                }
                await statusChanged()

                // Refuse before the FIRST ALTER USER when a running container was built
                // from another install's config store and this rotation would lock it
                // out. Placed ahead of every write, so a refusal leaves the stack in the
                // state it was already in.
                const driftCfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                await assertNoDbCredentialDrift(nextCoin, nextNetwork, {
                    decoder: driftCfg["DECODER_DB_PASS"],
                    indexer: driftCfg["INDEXER_DB_PASS"]
                })

                let containerId = await db.getModuleContainer(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                if (containerId) {
                    const cfg = await getDefaultConfig(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                    await addUserPasswordToDatabase(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork, cfg["DECODER_DB_NAME"], cfg["DECODER_DB_USER"], cfg["DECODER_DB_PASS"])
                    accountsProvisioned++
                }

                containerId = await db.getModuleContainer(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                if (containerId) {
                    const cfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                    await addUserPasswordToDatabase(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork, cfg["INDEXER_DB_NAME"], cfg["INDEXER_DB_USER"], cfg["INDEXER_DB_PASS"])
                    await addUserPasswordToDatabase(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork, cfg["DECODER_DB_NAME"], cfg["DECODER_DB_USER"], cfg["DECODER_DB_PASS"])
                    accountsProvisioned += 2
                }
            } catch (err) {
                logger.info(err)
                // Only claim a networking cause when the failure could plausibly be
                // one. A credential-drift refusal already carries its own diagnosis
                // and remediation, and appending a docker-network line to it sends
                // the operator hunting the wrong layer.
                if (!isDbCredentialDriftError(err)) {
                    logger.info("There was a problem adding the database container to the docker network of " + nextCoin + " " + nextNetwork)
                }
                throw err
            }
    return accountsProvisioned
}

async function provisionDatabaseAccounts(installedCoinsAndNetworks, dbContainerId) {
    let accountsProvisioned = 0
    for (const nextCoin in installedCoinsAndNetworks) {
        for (const nextNetwork of installedCoinsAndNetworks[nextCoin]) {
            accountsProvisioned += await provisionDatabaseAccount(nextCoin, nextNetwork, dbContainerId)
        }
    }
    return accountsProvisioned
}

async function setDatabaseParameters() {
    // Both callers (NodeService.installNode, ModuleService update) run this straight
    // after a decoder/indexer buildAndUp, and it is the ONLY step that writes the
    // freshly-minted per-install password into MariaDB. If the module set comes back
    // empty the loop body never executes and a successful return would let the caller's
    // throw-on-error guard never fires and the install reports success while the new
    // container crash-loops on ER_ACCESS_DENIED. Provisioning nothing is never success
    // here: fail closed on an unready store and on an empty set alike.
    db.assertReady("setting decoder/indexer database parameters")

    const { getInstalledCoinsAndNetworks } = statusService
    const installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    const dbContainerId = EXTERNAL_DB ? null : await getDatabaseContainerId()

    if (Object.keys(installedCoinsAndNetworks).length === 0) {
        throw new Error(
            "setDatabaseParameters found no installed coin/network, so no decoder/indexer MariaDB " +
            "account would be provisioned. The module registry is empty or unreadable."
        )
    }
    const accountsProvisioned = await provisionDatabaseAccounts(installedCoinsAndNetworks, dbContainerId)

    // A registry that lists coins but no decoder/indexer container is the same
    // silent-success hazard one level down: every getModuleContainer missed, so
    // nothing was force-set and the just-built container keeps a password that
    // exists nowhere in MariaDB.
    if (accountsProvisioned === 0) {
        throw new Error(
            "setDatabaseParameters provisioned no MariaDB account: the registry lists " +
            Object.keys(installedCoinsAndNetworks).join(", ") +
            " but holds no decoder or indexer container for them."
        )
    }

    return true
}

// Provision/rotate the SHARED hub DB account. setDatabaseParameters above covers the
// per-coin decoder/indexer accounts but not the hub (a shared service with no coin/network),
// so an `update xchain-hub` would rebuild the container with a new HUB_DB_PASS in its env yet
// leave the live hub account on the old password -> ER_ACCESS_DENIED lockout. Mirror the
// install-time provisioning (HubService.installHubModule) so a hub update force-sets the hub
// account to the configured password too. Reuses addUserPasswordToDatabase's unconditional
// CREATE IF NOT EXISTS + ALTER, so it self-heals any sidecar-vs-DB drift. The caller invokes
// this only after a successful hub buildAndUp, so the hub exists.
async function setHubDatabaseParameters() {
    const cfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)

    // Refuse before the ALTER USER when another running container holds this shared
    // account on a different password: the hub half of the guard above.
    // Excludes this install's own hub, which the caller has just rebuilt on the
    // intended password, so its frozen value is not a lockout.
    await assertNoHubDbCredentialDrift(
        { user: cfg["HUB_DB_USER"], pass: cfg["HUB_DB_PASS"] },
        { excludeContainers: [getDockerContainerImageName(HUB_MODULE_NAME, "", "")] }
    )

    await addUserPasswordToDatabase(HUB_MODULE_NAME, "", "", cfg["HUB_DB_NAME"], cfg["HUB_DB_USER"], cfg["HUB_DB_PASS"])
    return true
}


module.exports = { setDatabaseParameters, setHubDatabaseParameters, configureDependencies }
