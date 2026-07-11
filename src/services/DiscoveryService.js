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
 * XChain Node - Discovery Service
 *
 * Auto-discovers existing xchain-node Docker containers and registers
 * them in the modules table. Source of truth for the module → container_id
 * mapping is rebuildable from `docker ps -a` because container names
 * encode (module, coin, network) deterministically.
 *
 * Used in precheck when the modules table is empty (fresh install or
 * upgrade from LevelDB) and exposed via `xchain-node sync` for manual
 * reconciliation.
 ********************************************************************/

const { execFile } = require('child_process')

const {
    NODE_PREFIX, SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    XChainService, Coin, Network
} = require('../config/constants')
const { db } = require('../state')
const { stringToXChainService } = require('../utils/helpers')

// Every coin/network-independent service whose container is named bare
// NODE_PREFIX+SEP+module and whose registry row is (module,'',''). Must stay in
// lockstep with ConfigService.getDockerContainerImageNamePrefix and buildAndUp's
// shared-service cases: omitting one (as happened with sync) makes
// classifyContainer return null, so the per-command orphan-purge sweep deletes
// the live row and its module ops silently no-op.
const SHARED_MODULES = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]

function logIfNotSilent(silent, message) {
    if (!silent) console.log(message)
}

// Resolve a docker container to its registry identity { module, coin, network }
// (coin/network are '' for shared modules), or null for non-xchain containers.
//
// Identity comes from the CONTAINER NAME, the stable key the CLI itself
// assigns at creation (and what the file header above promises). The image
// tag is NOT reliable: rebuilding a module's image while the old container is
// still running steals the tag, docker then reports that container's image as
// a bare ID, and an image-keyed scan goes blind to a live, healthy container.
// Worse, the orphan purge below then DELETES its registry row, after which
// update/start/stop silently no-op for it (node-host-b litecoin-mainnet
// xchain-indexer incident, 2026-06-11). The image name remains a fallback for
// containers that were renamed externally.
function classifyContainer(container) {
    const name  = String((Array.isArray(container.Names) ? container.Names[0] : container.Names) || '').replace(/^\//, '')
    const image = String(container.Image || '')
    const identity = name.startsWith(NODE_PREFIX + SEP) ? name : image
    if (!identity.startsWith(NODE_PREFIX + SEP)) return null

    const rest = identity.substr(NODE_PREFIX.length + SEP.length)
    if (SHARED_MODULES.includes(rest)) return { module: rest, coin: "", network: "" }

    const parts = rest.split(SEP)
    if (parts.length < 3) return null

    const coinStr    = parts[0]
    const networkStr = parts[1]
    const moduleStr  = parts.slice(2).join(SEP)

    if (!Object.values(Coin).includes(coinStr) || !Object.values(Network).includes(networkStr)) return null

    let module = stringToXChainService(moduleStr)
    if (module != null) {
        module = XChainService[module]
    } else if (moduleStr === NODE_MODULE_NAME) {
        module = NODE_MODULE_NAME
    } else {
        return null
    }
    return { module, coin: coinStr, network: networkStr }
}

async function scanAndRegisterModules({ silent = false } = {}) {
    const containers = await new Promise((resolve, reject) => {
        execFile('docker', ['ps', '-a', '--no-trunc', '--format', 'json'], (error, stdout) => {
            if (error) return reject(error)
            const list = stdout.trim()
                .split('\n').filter(line => line.trim().length > 0)
                .map(line => JSON.parse(line))
            resolve(list)
        })
    })

    let added       = 0
    let reconciled  = 0
    let removed     = 0
    // Track which (module, coin, network) keys we saw a live container for, so
    // we can purge orphan rows whose registered container_id no longer maps to
    // any docker container at all.
    const seen = new Set()
    const keyOf = (module, coin, network) => module + '|' + coin + '|' + network

    // Sort containers so RUNNING ones come first. When multiple containers
    // share the same expected key (e.g. an old exited container and a fresh
    // running one), the running ID wins on the upsert.
    containers.sort((a, b) => {
        const ar = (a.State || '').toLowerCase() === 'running' ? 0 : 1
        const br = (b.State || '').toLowerCase() === 'running' ? 0 : 1
        return ar - br
    })

    for (const nextContainer of containers) {
        const identity = classifyContainer(nextContainer)
        if (identity == null) continue
        const { module, coin, network } = identity
        const label = (coin || network) ? (coin + SEP + network + SEP + module) : module

        // First-seen wins the upsert. Because the list is sorted RUNNING-first,
        // the running container reconciles the row first; any later duplicate
        // (e.g. a stopped container that classifies to the same key via the
        // image fallback) is skipped so it cannot overwrite the live ID with a
        // dead one. The key still records into `seen` for the orphan purge.
        const key = keyOf(module, coin, network)
        if (seen.has(key)) continue
        seen.add(key)
        const existing = await db.getModuleContainer(module, coin, network)
        if (existing == null) {
            await db.insertModuleContainer(module, coin, network, nextContainer.ID)
            logIfNotSilent(silent, "Added " + label + " (" + nextContainer.ID.slice(0,12) + ")")
            added++
        } else if (existing !== nextContainer.ID) {
            // Stale registry: running container has a different ID than recorded
            // (typically a rebuild that bypassed the CLI). insertModuleContainer
            // is an UPSERT, so this fixes the row in-place.
            await db.insertModuleContainer(module, coin, network, nextContainer.ID)
            logIfNotSilent(silent, "Reconciled " + label + " (was " + existing.slice(0,12) + ", now " + nextContainer.ID.slice(0,12) + ")")
            reconciled++
        }
    }

    // Purge orphan registry rows: modules table entries whose key we never
    // saw in `docker ps -a`, meaning the container was deleted externally
    // (or the row is otherwise unreferenced). Leaving these around makes
    // downstream operations log spurious "couldn't connect to network" /
    // "container not found" warnings against a phantom container.
    const allRows = await db.getAllModuleContainers(null, null)
    for (const row of allRows) {
        const k = keyOf(row.module, row.coin || '', row.network || '')
        if (seen.has(k)) continue
        await db.removeModuleContainer(row.module, row.coin || '', row.network || '')
        logIfNotSilent(silent, "Removed orphan registry row " +
            (row.coin || row.network ? (row.coin + SEP + row.network + SEP) : '') +
            row.module + " (was " + String(row.container_id || '').slice(0,12) + ")")
        removed++
    }

    return added + reconciled + removed
}

module.exports = {
    scanAndRegisterModules,
    classifyContainer
}
