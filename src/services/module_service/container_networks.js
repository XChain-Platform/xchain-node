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
 * XChain Node - Module Service
 * Clone, build, install and uninstall XChain modules
 ********************************************************************/

let { execFile } = require('child_process')
let { XChainService, Coin, Network } = require('../../config')
let { getDockerNetwork } = require('../config_service')
let { getStatus } = require('../status_service')
let { addContainerToNetwork } = require('../docker_service')
let { redactSecrets, sleep } = require('../../utils/helpers')
let memoryLimitService = require('../memory_limit_service')
const { getLogger } = require('../../observability/logger');
let logger = getLogger();

function configureDependencies(dependencies) {
    ({
        execFile, XChainService, Coin, Network, getDockerNetwork, getStatus,
        addContainerToNetwork, redactSecrets, sleep, memoryLimitService, logger
    } = dependencies)
}

/**
 * Which sibling-coin docker networks a module's container must join beyond its
 * own, given what is installed on this host. Pure; exported for tests.
 *
 * The indexer is the one module with cross-chain sibling reads: the ROLLCALL
 * epoch close and the ANCHOR reward rail both make a BTC indexer ask the DOGE
 * indexer of the SAME network what is on chain. Each coin/network stack runs on
 * its own bridge network, and container-name DNS only resolves across a network
 * both containers hold, so without the extra membership those reads can only
 * fail. `docker network connect` state dies with the container, which means a
 * hand-applied attach silently evaporates at the next update or recreate; the
 * attachment must be re-declared HERE, at every create. Membership is granted
 * to every locally installed sibling coin on the same network tier (mirroring
 * the hub, which joins every stack) rather than to dogecoin alone, so the next
 * cross-chain read does not need this file changed. Sibling stacks on other
 * hosts are out of scope by construction: their indexer URLs are real
 * hostnames, not container names, and docker networks do not span hosts.
 *
 * @param {string} module
 * @param {string|null} coin
 * @param {string|null} network
 * @param {Object<string,string[]>} installedCoinsAndNetworks coin -> networks
 * @returns {string[]} docker network names to join, sorted
 */
function crossChainNetworksFor(module, coin, network, installedCoinsAndNetworks) {
    if (module !== XChainService.XCHAIN_INDEXER) return []
    if (!coin || !network) return []
    const networks = []
    for (const siblingCoin in (installedCoinsAndNetworks || {})) {
        if (siblingCoin === coin) continue
        if ((installedCoinsAndNetworks[siblingCoin] || []).includes(network)) {
            networks.push(getDockerNetwork(siblingCoin, network))
        }
    }
    return networks.sort()
}

// Join a freshly created container to the sibling networks computed above.
// Same retry posture as the hub's attachSharedContainer: addContainerToNetwork
// is idempotent, one retry absorbs the docker race behind most failures. A
// persistent failure is reported loudly with its operational consequence but
// does not fail the create: the sibling stack may legitimately be mid-teardown,
// and the message names the exact symptom to look for and the remedy.
async function attachCrossChainNetworks(module, coin, network, containerId) {
    // The installed map mirrors StatusService.getInstalledCoinsAndNetworks but
    // is derived here from getStatus, the StatusService seam this module
    // already holds: pulling a second function out of StatusService widens the
    // coupling surface every consumer of this module has to satisfy.
    const modulesStatus = await getStatus(null, null, false)
    const installedCoinsAndNetworks = {}
    for (const nextCoin in modulesStatus) {
        if (!Object.values(Coin).includes(nextCoin)) continue
        installedCoinsAndNetworks[nextCoin] =
            Object.keys(modulesStatus[nextCoin]).filter(n => Object.values(Network).includes(n))
    }
    const networks = crossChainNetworksFor(module, coin, network, installedCoinsAndNetworks)
    for (const networkName of networks) {
        try {
            await addContainerToNetwork(containerId, networkName)
        } catch (firstErr) {
            await sleep(3000)
            try {
                await addContainerToNetwork(containerId, networkName)
            } catch (retryErr) {
                logger.error("WARNING: could not join " + module + " (" + coin + " " + network + ") to the "
                    + networkName + " network (" + redactSecrets(retryErr) + "). Cross-chain reads over that "
                    + "network (ROLLCALL epoch close, ANCHOR rewards) will stall while the container looks "
                    + "healthy. Remedy: docker network connect " + networkName + " " + containerId.slice(0, 12)
                    + ", or recreate the module once the network exists.")
            }
        }
    }
}

/**
 * Read a created container's memory limit back and warn when it did not stick.
 *
 * `docker run --memory` is advice, not a contract: on a kernel with no memory
 * cgroup controller (Raspberry Pi OS ships with it off) docker prints
 * "Limitation discarded", exits 0, and creates the container with
 * HostConfig.Memory=0. Nothing downstream notices, so the CLI's own note goes on
 * claiming a cap the tracker never received and the operator sizes the host
 * against a number that is not true. This is the only place that checks.
 *
 * Warns rather than throws: the container works exactly as it did before the cap
 * existed, and failing the create would block every install on such a host. A
 * reading that cannot be parsed (docker gone, an older stub, an empty answer) is
 * not evidence of anything and stays silent at debug.
 *
 * @param {string} containerId
 * @param {string} module
 * @param {string|null} coin
 * @param {string|null} network
 * @param {number|null} requestedMb the cap that was asked for, in MB
 * @returns {Promise<void>} always resolves; the finding is a log line, not a result
 */
function verifyContainerMemoryLimit(containerId, module, coin, network, requestedMb) {
    return new Promise((resolve) => {
        if (!requestedMb) {
            resolve()
            return
        }
        execFile('docker', ['inspect', '-f', '{{.HostConfig.Memory}}', containerId], (error, stdout) => {
            if (error) {
                logger.debug("Could not read the memory limit back off " + module + ": "
                    + redactSecrets(String(error.message || error)))
                resolve()
                return
            }
            const observedBytes = parseInt(String(stdout).trim(), 10)
            if (!Number.isFinite(observedBytes)) {
                logger.debug("Docker reported no readable memory limit for " + module + "; nothing to compare")
                resolve()
                return
            }
            // MB as docker parses `--memory 2703m`: powers of 1024, which is what
            // dockerMemoryArgs writes and what HostConfig.Memory reports back.
            if (observedBytes !== requestedMb * 1024 * 1024) {
                logger.warn(memoryLimitService.memoryCapNotAppliedWarning({
                    module, coin, network, requestedMb, observedBytes
                }))
            }
            resolve()
        })
    })
}

/**
 * Print what a SUCCESSFUL `docker run` said on stderr.
 *
 * Exit 0 with a warning on stderr is how docker reports that it accepted an
 * argument and then ignored it; a discarded memory limit is reported no other
 * way. Only stdout was ever read, so those lines went nowhere.
 *
 * @param {string|Buffer|undefined} stderr
 * @param {string} module
 * @param {string|null} coin
 * @param {string|null} network
 */
function logDockerCreateWarnings(stderr, module, coin, network) {
    const text = String(stderr || '').trim()
    if (!text) return
    const label = memoryLimitService.moduleLabel(module, coin, network)
    for (const line of text.split('\n')) {
        if (line.trim()) logger.warn("docker said while creating " + label + ": " + redactSecrets(line.trim()))
    }
}

module.exports = { configureDependencies, crossChainNetworksFor, attachCrossChainNetworks, verifyContainerMemoryLimit, logDockerCreateWarnings }
