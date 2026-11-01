/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Module Service part: free host ports for a second install
 *
 * Every coin/network install defaults its per-service host ports to the same
 * numbers (utxo-tracker 3001, decoder 3002, ...), so the second install on a
 * host (testnet beside mainnet, a second coin) asked for ports the first one
 * already published and stopped on a host port conflict. A port the registry
 * publishes only on request (no `always`) is reached by other containers on the
 * docker network, never through the host, so moving its host side is safe:
 * this picks the same port 100 higher until one is free (3001, 3101, 3201 ...),
 * which keeps a second install's ports out of the first install's 30xx band.
 * The hub and explorer ports (`always`) are what the CLI itself dials on
 * 127.0.0.1, so a conflict on one of them still stops the install.
 ********************************************************************/

'use strict'

const PORT_STEP = 100
const MAX_PORT = 65535

// The first port at `from + k * PORT_STEP` (k >= 1) that `taken` does not hold.
function nextFreeHostPort(from, taken) {
    for (let port = from + PORT_STEP; port <= MAX_PORT; port += PORT_STEP) {
        if (!taken.has(String(port))) return port
    }
    return null
}

// Move each conflicting on-request port of `claim.module` to a free host port:
// rewrites its `-p` value in `portArgs` and its host key in
// `claim.environmentVariables`, and drops it from `conflicts`. Returns
// `conflicts` with only the ports it could not move. With no `claim` it changes
// nothing, so a caller that does not opt in keeps the plain conflict error.
function claimFreeHostPorts(conflicts, portArgs, requested, published, claim) {
    if (!claim || conflicts.length === 0) return conflicts
    const { module, environmentVariables, registry, logger } = claim
    const facet = registry[module] && registry[module].docker
    const ports = (facet && facet.ports) || []
    const taken = new Set([...published.keys(), ...requested].map(String))
    for (let c = conflicts.length - 1; c >= 0; c--) {
        const { hostPort, holders } = conflicts[c]
        const entry = ports.find(p => !p.always && String(environmentVariables[p.host]) === hostPort)
        if (!entry) continue
        const at = portArgs.indexOf(`${environmentVariables[entry.host]}:${environmentVariables[entry.container]}`)
        if (at < 1 || portArgs[at - 1] !== '-p') continue
        const free = nextFreeHostPort(Number(hostPort), taken)
        if (free === null) continue
        taken.add(String(free))
        environmentVariables[entry.host] = free
        portArgs[at] = `${free}:${environmentVariables[entry.container]}`
        logger.info(`Host port ${hostPort} (${entry.host}) is already published by ${holders.join(', ')}; ` +
            `publishing ${module} on host port ${free} instead. Set ${entry.host} in config to choose another.`)
        conflicts.splice(c, 1)
    }
    return conflicts
}

module.exports = { PORT_STEP, nextFreeHostPort, claimFreeHostPorts }
