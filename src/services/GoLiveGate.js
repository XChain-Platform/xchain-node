'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Go-live pre-flight gate, from a launch-readiness review finding. Every safe
// launch setting used to be an individual thing-someone-must-remember; this
// gate asserts them together at the one chokepoint every service deploy
// passes through (buildAndUp), so a mainnet write surface cannot boot with
// un-armed settings once the operator flips XCHAIN_NODE_GO_LIVE=1.
//
// Modes:
//   - XCHAIN_NODE_GO_LIVE unset (pre-launch, today's fleet): violations are
//     WARNINGS only. Routine mainnet installs/updates keep working while the
//     flag-day placeholders are still intentionally un-armed (pending).
//   - XCHAIN_NODE_GO_LIVE=1 (set fleet-wide at the launch flip, per the
//     checklist): violations REFUSE the install/update of a mainnet write
//     surface.
//   - XCHAIN_NODE_SKIP_GO_LIVE_GATE=1: explicit escape hatch, logged loudly.

const fs   = require('fs')
const path = require('path')

const {
    HUB_MODULE_NAME,
    SYNC_MODULE_NAME,
    XChainService,
    Network
} = require('../config/constants')

// The 5 un-decided flag-days share this placeholder activation timestamp
// (2026-12-31T22:00:00Z). Its presence in a service's consensus sources means
// the flag-day has not been armed yet: shipping that to a live mainnet
// silently leaves the gated behavior off until 2027.
const FLAG_DAY_PLACEHOLDER = '1798761600'

// Services whose mainnet deployment accepts writes or feeds consensus, and
// therefore must not boot un-armed. Read surfaces (explorer, decoder,
// utxo-tracker) and dev-only services are exempt.
const WRITE_SURFACES = new Set([
    XChainService.XCHAIN_INDEXER,
    XChainService.XCHAIN_ENCODER,
    HUB_MODULE_NAME,
    SYNC_MODULE_NAME
])

function isTruthyEnv(value) {
    return value !== undefined && value !== '' && value !== '0' && String(value).toLowerCase() !== 'false' && String(value).toLowerCase() !== 'no'
}

// Recursively scan a service's src/ tree for the flag-day placeholder
// timestamp. Bundled libraries and deps are skipped; only first-party
// consensus sources (protocol_changes.js, *_activation.js and anything else
// under src/) are relevant.
function findFlagDayPlaceholders(moduleDir) {
    const hits = []
    const srcDir = path.join(moduleDir, 'src')
    if (!fs.existsSync(srcDir)) return hits

    const walk = (dir) => {
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                let content
                try { content = fs.readFileSync(full, 'utf8') } catch { continue }
                if (content.includes(FLAG_DAY_PLACEHOLDER)) {
                    hits.push(path.relative(moduleDir, full))
                }
            }
        }
    }
    walk(srcDir)
    return hits
}

// Collect go-live violations for one service deploy. environmentVariables is
// the generated container env (getDefaultConfig output); host process.env is
// consulted as the fallback for keys the config layer only passes through.
function collectViolations(module, environmentVariables, moduleDir) {
    const violations = []
    const env = environmentVariables || {}
    const hostEnv = process.env

    const keySet = (name) => {
        const v = env[name] !== undefined ? env[name] : hostEnv[name]
        return v !== undefined && v !== ''
    }

    if (module === XChainService.XCHAIN_INDEXER) {
        if (!keySet('INDEXER_API_KEY')) violations.push("INDEXER_API_KEY is not set (hub→indexer federation reads stay fail-closed, but the shared-secret must exist on a live box; export it in the host env)")
        if (!keySet('HUB_API_KEY')) violations.push("HUB_API_KEY is not set (indexer's consensus pushes to the hub will 401 or, on an un-keyed hub, run unauthenticated)")
    }
    if (module === HUB_MODULE_NAME) {
        if (!keySet('HUB_API_KEY')) violations.push('HUB_API_KEY is not set (hub consensus-affecting write methods run OPEN)')
    }
    if (module === XChainService.XCHAIN_ENCODER) {
        if (!keySet('API_KEY') && !keySet('ENCODER_API_KEY')) violations.push('API_KEY is not set (encoder API, including broadcast_tx, runs OPEN)')
    }
    if (module === SYNC_MODULE_NAME) {
        if (!keySet('SYNC_API_KEY')) violations.push('SYNC_API_KEY is not set (sync REST/WS API runs UNAUTHENTICATED and /halt/clear is disabled)')
    }

    if (hostEnv.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP !== undefined && !isTruthyEnv(hostEnv.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP)) {
        violations.push('XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP is disabled (unsigned bootstrap restores allowed); unset it for launch')
    }

    if (moduleDir) {
        const placeholders = findFlagDayPlaceholders(moduleDir)
        if (placeholders.length > 0) {
            violations.push('flag-day placeholder timestamp ' + FLAG_DAY_PLACEHOLDER + ' (un-armed) present in: ' + placeholders.join(', '))
        }
    }

    return violations
}

// Called from buildAndUp for every service deploy. Throws (refuses the
// deploy) only when the operator has armed XCHAIN_NODE_GO_LIVE and the deploy
// targets a mainnet write surface with violations; otherwise warns. The hub
// and sync are shared services deployed with no coin/network, so for them the
// gate keys off go-live arming alone.
function assertGoLiveReady(module, coin, network, environmentVariables, moduleDir) {
    if (!WRITE_SURFACES.has(module)) return

    const armed = isTruthyEnv(process.env.XCHAIN_NODE_GO_LIVE)
    const sharedService = (module === HUB_MODULE_NAME || module === SYNC_MODULE_NAME) && !network
    const mainnetSurface = network === Network.MAINNET || sharedService
    if (!mainnetSurface) return

    if (isTruthyEnv(process.env.XCHAIN_NODE_SKIP_GO_LIVE_GATE)) {
        console.warn('WARNING: XCHAIN_NODE_SKIP_GO_LIVE_GATE is set; go-live pre-flight checks SKIPPED for ' + module)
        return
    }

    const violations = collectViolations(module, environmentVariables, moduleDir)
    if (violations.length === 0) return

    const header = 'Go-live pre-flight (' + module + (coin && network ? ' ' + coin + '/' + network : '') + '):'
    const lines = violations.map((v) => ' - ' + v)
    if (armed) {
        throw new Error(header + ' REFUSING to deploy a mainnet write surface with un-armed settings (XCHAIN_NODE_GO_LIVE is set).\n'
            + lines.join('\n')
            + '\nSee the go-live checklist. To bypass once (not for launch): XCHAIN_NODE_SKIP_GO_LIVE_GATE=1')
    }
    console.warn('WARNING: ' + header + ' un-armed launch settings detected (deploy proceeds; will REFUSE once XCHAIN_NODE_GO_LIVE=1):\n' + lines.join('\n'))
}

module.exports = {
    assertGoLiveReady,
    collectViolations,
    findFlagDayPlaceholders,
    FLAG_DAY_PLACEHOLDER
}
