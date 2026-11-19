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

// Split a `-p` value on its last colon into [IP:]HOST:CONTAINER fields (ip is
// '' when absent); null for a non-string or colon-less value.
function parsePortSpec(pair) {
    if (typeof pair !== 'string') return null
    const colonIdx = pair.lastIndexOf(':')
    if (colonIdx === -1) return null
    const beforeContainer = pair.substring(0, colonIdx)
    const hostIdx = beforeContainer.lastIndexOf(':')
    return {
        ip: hostIdx === -1 ? '' : beforeContainer.substring(0, hostIdx),
        hostPort: beforeContainer.substring(hostIdx + 1),
        containerPort: pair.substring(colonIdx + 1)
    }
}

function duplicateRequestedHostPorts(requested) {
    const byHostPort = new Map()
    for (const spec of requested) {
        const pairs = byHostPort.get(spec.hostPort) || []
        pairs.push(spec.pair)
        byHostPort.set(spec.hostPort, pairs)
    }
    return [...byHostPort].filter(([, pairs]) => pairs.length > 1)
}

function requestedHostPorts(portArgs) {
    const requested = []
    for (let i = 0; i < portArgs.length; i++) {
        if (portArgs[i] !== '-p') continue
        const spec = parsePortSpec(portArgs[i + 1])
        if (spec && /^\d+$/.test(spec.hostPort)) {
            requested.push({ hostPort: spec.hostPort, pair: portArgs[i + 1] })
        }
    }
    const duplicates = duplicateRequestedHostPorts(requested)
    if (duplicates.length === 0) return requested.map(spec => spec.hostPort)
    const lines = duplicates.map(([hostPort, pairs]) =>
        `  host port ${hostPort} is requested more than once: ${pairs.join(', ')}`)
    throw new Error(
        'Host port conflict: one container cannot publish the same host port more than once:\n' +
        lines.join('\n') + '\n' +
        'Give each binding its own host port in config/<coin>-<network> ' +
        '(for example, EXPLORER_PORT_HTTP and EXPLORER_PORT_HTTPS).'
    )
}

// Host ports (from getAllBoundHostPorts' map) that some container other than
// `selfName` has saved in its port bindings, stopped containers included: a
// replacement port must not be one of these, or starting that container later
// fails with "port is already allocated".
function reservedHostPorts(bound, selfName) {
    const reserved = new Set()
    for (const [port, holders] of bound) {
        if ([...holders].some(name => name !== selfName)) reserved.add(port)
    }
    return reserved
}

// Host ports a replacement port must avoid. A port published only by the
// container being recreated (`claim.selfName`) is free: that container is
// removed by name before `docker run`, so counting it would flip the claimed
// port between two values on every rebuild. `claim.reserved` adds the ports a
// stopped container will bind again on start, which `published` (running
// containers only) cannot see.
function takenHostPorts(published, requested, claim) {
    const taken = new Set(requested.map(String))
    for (const [port, holders] of published) {
        if (claim.selfName && [...holders].every(name => name === claim.selfName)) continue
        taken.add(String(port))
    }
    for (const port of claim.reserved || []) taken.add(String(port))
    return taken
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
    const taken = takenHostPorts(published, requested, claim)
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

module.exports = {
    PORT_STEP, nextFreeHostPort, claimFreeHostPorts, parsePortSpec,
    requestedHostPorts, reservedHostPorts
}
