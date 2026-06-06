/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME,
    XChainService, Coin, Network
} = require('../config/constants')
const { db } = require('../state')
const { stringToXChainService } = require('../utils/helpers')

const SHARED_MODULES = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME]

function logIfNotSilent(silent, message) {
    if (!silent) console.log(message)
}

async function scanAndRegisterModules({ silent = false } = {}) {
    const validCoins    = Object.values(Coin)
    const validNetworks = Object.values(Network)

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

    // Sort containers so RUNNING ones come first — when multiple containers
    // share the same expected key (e.g. an old exited container and a fresh
    // running one), the running ID wins on the upsert.
    containers.sort((a, b) => {
        const ar = (a.State || '').toLowerCase() === 'running' ? 0 : 1
        const br = (b.State || '').toLowerCase() === 'running' ? 0 : 1
        return ar - br
    })

    for (const nextContainer of containers) {
        const imageName = nextContainer.Image
        if (!imageName.startsWith(NODE_PREFIX + SEP)) continue

        const rest = imageName.substr(NODE_PREFIX.length + SEP.length)

        if (SHARED_MODULES.includes(rest)) {
            seen.add(keyOf(rest, "", ""))
            const existing = await db.getModuleContainer(rest, "", "")
            if (existing == null) {
                await db.insertModuleContainer(rest, "", "", nextContainer.ID)
                logIfNotSilent(silent, "Added " + rest + " (" + nextContainer.ID.slice(0,12) + ")")
                added++
            } else if (existing !== nextContainer.ID) {
                // Stale registry — running container has a different ID than recorded
                // (typically a rebuild that bypassed the CLI). insertModuleContainer
                // is an UPSERT, so this fixes the row in-place.
                await db.insertModuleContainer(rest, "", "", nextContainer.ID)
                logIfNotSilent(silent, "Reconciled " + rest + " (was " + existing.slice(0,12) + ", now " + nextContainer.ID.slice(0,12) + ")")
                reconciled++
            }
            continue
        }

        const parts = rest.split(SEP)
        if (parts.length < 3) continue

        const coinStr    = parts[0]
        const networkStr = parts[1]
        const moduleStr  = parts.slice(2).join(SEP)

        if (!validCoins.includes(coinStr) || !validNetworks.includes(networkStr)) continue

        let module = stringToXChainService(moduleStr)
        if (module != null) {
            module = XChainService[module]
        } else if (moduleStr === NODE_MODULE_NAME) {
            module = NODE_MODULE_NAME
        }

        if (module != null) {
            seen.add(keyOf(module, coinStr, networkStr))
            const existing = await db.getModuleContainer(module, coinStr, networkStr)
            if (existing == null) {
                await db.insertModuleContainer(module, coinStr, networkStr, nextContainer.ID)
                logIfNotSilent(silent, "Added " + coinStr + SEP + networkStr + SEP + module + " (" + nextContainer.ID.slice(0,12) + ")")
                added++
            } else if (existing !== nextContainer.ID) {
                await db.insertModuleContainer(module, coinStr, networkStr, nextContainer.ID)
                logIfNotSilent(silent, "Reconciled " + coinStr + SEP + networkStr + SEP + module + " (was " + existing.slice(0,12) + ", now " + nextContainer.ID.slice(0,12) + ")")
                reconciled++
            }
        }
    }

    // Purge orphan registry rows — modules table entries whose key we never
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
    scanAndRegisterModules
}
