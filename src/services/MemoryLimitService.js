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
 *
 * XChain Node - container memory limits
 *
 * The utxo-tracker sizes its LevelDB cache, heap-flush threshold and bulk-sync
 * budget from the memory it may use, read from the cgroup when one binds below
 * host RAM (xchain-utxo-tracker/src/memoryBudget.js). Nothing ever set that
 * limit: every container ran with HostConfig.Memory=0, so every tracker took
 * fractions of the WHOLE host, and N trackers on one box oversubscribed it
 * (operator report 2026-09-07: three trackers on a 16 GB host intended 13.7 GB
 * before the chain daemons and MariaDB; the mainnet one reached 5.9 GB RSS).
 *
 * The orchestrator is the one thing that knows how many trackers share the
 * host, so it hands each one its share: half the host, divided by the number
 * of installed trackers, floored and ceilinged. --memory-swap is set equal to
 * --memory, because a LevelDB cache paged out to swap is slower than a smaller
 * cache and a clean OOM is at least visible.
 *
 * Only the tracker is capped by default. It is the one service that reads the
 * cgroup limit and sizes itself inside it; capping a service that does NOT
 * (decoder, indexer, hub) turns a transient spike into an OOM kill and a
 * restart loop, which is the failure the tracker's budget code exists to stop.
 * Any module can still be capped explicitly with
 * XCHAIN_NODE_MODULE_MEMORY_MB_<SERVICE> (0 disables a derived cap).
 *
 ********************************************************************/

const os = require('os')
const { XChainService } = require('../config/constants')

const MIB = 1024 * 1024

// Trackers together may claim this share of the host; the rest is for the chain
// daemons (a synced bitcoind alone holds 3-4 GB), MariaDB, the decoders, the
// indexers, the hub, the explorer and the OS.
const TRACKER_HOST_SHARE = 0.5

// Below this the tracker's own floors (128 MiB cache + 256 MB heap flush +
// 512 MB bulk-sync merge) plus process overhead do not fit, and a cap only
// produces the restart loop it is meant to prevent. A host that cannot afford
// the floor for every tracker gets the floor anyway, with a warning.
const TRACKER_FLOOR_MB = 1024

// memoryBudget clamps each slice at 4 GiB, so past this a cap changes nothing
// the tracker would do; it only stops a runaway from taking the host.
const TRACKER_CEILING_MB = 16384

// XCHAIN_NODE_MODULE_MEMORY_MB_XCHAIN_UTXO_TRACKER, and so on.
function moduleEnvKey(module) {
    return 'XCHAIN_NODE_MODULE_MEMORY_MB_' + String(module).toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

// The operator's explicit limit for a module in MB: null when unset or
// unparseable (logged by the caller as ignored), 0 when explicitly disabled.
function envMemoryMb(module, env = process.env) {
    const raw = env[moduleEnvKey(module)]
    if (raw === undefined || raw === '') return null
    if (!/^\d+$/.test(String(raw).trim())) return null
    return parseInt(raw, 10)
}

// The derived per-tracker limit.
function trackerMemoryLimitMb({ hostBytes, trackerCount }) {
    const count = Math.max(1, Number(trackerCount) || 1)
    const shareMb = Math.floor((Number(hostBytes) * TRACKER_HOST_SHARE) / count / MIB)
    const floored = shareMb < TRACKER_FLOOR_MB
    const mb = Math.min(TRACKER_CEILING_MB, Math.max(TRACKER_FLOOR_MB, shareMb))
    return { mb, shareMb, floored, count }
}

function dockerMemoryArgs(mb) {
    return ['--memory', mb + 'm', '--memory-swap', mb + 'm']
}

// The docker run args for a module's memory limit, and where they came from:
//   { args, source: 'env' | 'derived' | 'none', mb, note }
// `note` is a line worth printing at create time (a cap, an ignored value, or a
// host too small for its trackers); null when there is nothing to say.
function memoryArgsFor(module, { hostBytes = os.totalmem(), trackerCount = 1, env = process.env } = {}) {
    const key = moduleEnvKey(module)
    const raw = env[key]
    const explicit = envMemoryMb(module, env)
    if (raw !== undefined && raw !== '' && explicit === null) {
        return { args: [], source: 'none', mb: null,
            note: key + '=' + JSON.stringify(raw) + ' is not a whole number of MB; ignored' }
    }
    if (explicit !== null) {
        if (explicit === 0) {
            return { args: [], source: 'env', mb: 0, note: key + '=0: no memory limit for ' + module }
        }
        return { args: dockerMemoryArgs(explicit), source: 'env', mb: explicit,
            note: 'memory limit for ' + module + ': ' + explicit + ' MB (' + key + ')' }
    }
    if (module !== XChainService.XCHAIN_UTXO_TRACKER) {
        return { args: [], source: 'none', mb: null, note: null }
    }
    const d = trackerMemoryLimitMb({ hostBytes, trackerCount })
    const hostMb = Math.floor(Number(hostBytes) / MIB)
    let note = 'memory limit for ' + module + ': ' + d.mb + ' MB (host ' + hostMb + ' MB, '
        + Math.round(TRACKER_HOST_SHARE * 100) + '% shared by ' + d.count + ' tracker' + (d.count === 1 ? '' : 's') + ')'
    if (d.floored) {
        note += '. WARNING: the derived share (' + d.shareMb + ' MB) is under the ' + TRACKER_FLOOR_MB
            + ' MB floor a tracker needs; ' + d.count + ' trackers on this host will oversubscribe it. '
            + 'Run fewer chains here, or set ' + key + ' per host after measuring.'
    }
    return { args: dockerMemoryArgs(d.mb), source: 'derived', mb: d.mb, note }
}

// How many trackers share this host once `coin`/`network`'s tracker exists:
// every tracker row in the registry, plus this one if it is not registered yet.
// A registry that cannot be read (or a test double without the method) counts
// one, which is the most generous share and never a smaller cap than before.
async function countInstalledTrackers(db, { coin, network } = {}) {
    let rows = []
    try {
        if (db && typeof db.getAllModuleContainers === 'function') {
            rows = (await db.getAllModuleContainers(null, null)) || []
        }
    } catch (_) {
        rows = []
    }
    const trackers = rows.filter(r => r && r.module === XChainService.XCHAIN_UTXO_TRACKER)
    const hasThis = trackers.some(r => r.coin === coin && r.network === network)
    return trackers.length + (hasThis ? 0 : 1)
}

module.exports = {
    memoryArgsFor,
    trackerMemoryLimitMb,
    countInstalledTrackers,
    envMemoryMb,
    moduleEnvKey,
    TRACKER_HOST_SHARE,
    TRACKER_FLOOR_MB,
    TRACKER_CEILING_MB
}
