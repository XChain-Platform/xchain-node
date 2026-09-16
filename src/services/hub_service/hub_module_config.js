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

const { HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SERVICE_REGISTRY } = require('../../config')
const { getDockerContainerImageName } = require('../config_service')
const { readContainerEnv } = require('../db_credential_drift')
const config = require('../../config');

// Build the hub/explorer per-module config descriptor from the table-driven
// SERVICE_REGISTRY (constants.js) instead of a hand-maintained switch/case.
// Returns null for modules that contribute no hub config (hub/explorer/sync
// themselves, e2e-test) so the caller skips them, matching the old
// switch's default-no-op. The database descriptor is external-vs-dockerized
// and resolved from `ctx`; every other descriptor is a straight field map
// read from the coin/network default config.
function buildHubModuleConfig(nextModule, defaultConfigCoinNetwork, ctx) {
    const hubConfig = (SERVICE_REGISTRY[nextModule] || {}).hubConfig
    // A module with no hub-config descriptor contributes nothing to the hub, so skip it.
    if (!hubConfig) return null

    if (hubConfig.type === 'database') {
        // External DB has no container; point the hub at the configured
        // external host so its module-config view reflects reality.
        return ctx.EXTERNAL_DB
            ? { host: ctx.externalDbCfg.host, port: ctx.externalDbCfg.port }
            : { host: 'mariadb', port: 3306 }
    }

    const config = {}
    for (const [outKey, envKey] of Object.entries(hubConfig.fields)) {
        config[outKey] = defaultConfigCoinNetwork[envKey]
    }
    return config
}

// The explorer's checkpoint/proof/cross-chain routes
// read state_checkpoints / capability_snapshots / cross_chain_matches from a
// LOCAL schema (config database.checkpoint), because xchain-sync deliberately
// never replicates those hub-mirrored tables. A deployment with no externally-
// maintained hub schema colocated with the explorer needs one the explorer's
// own HubMirrorSyncManager self-provisions and keeps live over the hub's
// /hub-db feed instead (self_sync: true). Wired in below behind the
// EXPLORER_CHECKPOINT_SELF_SYNC opt-in (paired with the HUB_API_URL
// passthrough in ConfigService, which the mirror writer needs to reach the
// hub); a deployment that already points database.checkpoint at a real hub
// schema by hand, or wants the routes to just 500 (ALLOW_NO_COLOCATED_HUB_DB),
// leaves this env unset and is unaffected.
//
// db.js's _checkpointSource only honours an entry whose host/port/user/pass
// EXACTLY match the indexer DB (db.js:481), so this reads the SAME
// defaultConfigCoinNetwork fields buildHubModuleConfig('xchain-indexer', ...)
// reads above, rather than re-deriving them, to guarantee byte-identical
// values instead of two independent paths that could drift apart.
//
// hub_url ships IN this block, beside self_sync, so the pairing is structural:
// whatever condition produces self_sync produces the URL with it. Emitted by
// separate conditions, an explorer opted in after its container exists is told
// to self-sync with no hub URL to sync from, warns once at startup and then
// serves the frozen mirror indefinitely. This block reaches the explorer over
// the hub's config push; HUB_API_URL is a container env ConfigService writes at
// install/recreate time from the same host env var, and the explorer falls back
// to it for hand-written config.json deployments.
function buildCheckpointConfig(defaultConfigCoinNetwork) {
    return {
        hub_url: config.HUB_API_URL ||
            ("http://" + getDockerContainerImageName(HUB_MODULE_NAME, "", "") + ":" +
             defaultConfigCoinNetwork.HUB_PORT),
        db_host:   defaultConfigCoinNetwork.INDEXER_DB_HOST,
        db_port:   defaultConfigCoinNetwork.INDEXER_DB_PORT,
        user:      defaultConfigCoinNetwork.INDEXER_DB_USER,
        pass:      defaultConfigCoinNetwork.INDEXER_DB_PASS,
        // A dedicated schema beside the indexer DB, never the indexer schema
        // itself: HubMirrorPool.ensureDatabase() runs CREATE DATABASE IF NOT
        // EXISTS on this name under the same indexer DB user, which must
        // therefore be able to create it (or it must already exist, pre-granted).
        name:      defaultConfigCoinNetwork.INDEXER_DB_NAME + '_HubMirror',
        self_sync: true
    }
}

// Is the self-synced checkpoint mirror opted in for THIS deployment?
//
// EXPLORER_CHECKPOINT_SELF_SYNC is a host env read at command time, but the
// checkpoint blocks it produces are written per coin/network into stores that are
// only ever upserted, never reconciled. So the opt-in has to outlive the shell that
// first set it, and as a bare `process.env` read it did not: a coin installed later
// from a shell that never exported the env (a second terminal, a cron-driven update,
// an operator who sourced a different env file) got NO checkpoint block, while the
// coins installed earlier kept theirs. The explorer then serves exactly one coin's
// hub-mirrored routes as a fail-loud 500 - price_snapshots, oracle_prices,
// state_checkpoints, capability_snapshots, cross_chain_matches - while every sibling
// coin answers normally, which reads as a broken query rather than the config gap it
// is (and with ALLOW_NO_COLOCATED_HUB_DB=1 the explorer boots anyway, so nothing at
// startup says so either). Measured on a regtest venue whose LTC leg 500'd on
// /RLTC/api/price_snapshots/FINALIZED/status while RBTC and RDOGE were fine.
//
// The installed explorer container's own env is the durable record of the earlier
// opt-in: ConfigService writes HUB_API_URL into the explorer ONLY inside the same
// opt-in branch, so its presence there means self-sync was chosen for this
// deployment. Reading it back makes every later push emit the block for every
// installed coin, so the gap self-heals on the next mutation instead of needing a
// hand-edit. Tolerant by design: no explorer container, or an unreadable one, is
// simply "not opted in".
async function isCheckpointSelfSyncEnabled(deps = {}) {
    const env = deps.env || config.CHECKPOINT_SELF_SYNC_ENV
    // An opt-in exported in the invoking shell counts on its own, before any container is read.
    if (env.EXPLORER_CHECKPOINT_SELF_SYNC !== undefined && env.EXPLORER_CHECKPOINT_SELF_SYNC !== "") return true

    const readEnv = deps.readContainerEnv || readContainerEnv
    const containerEnv = await readEnv(getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""), deps)
    // No explorer container, or one whose environment cannot be read, means self-sync was not chosen.
    if (!containerEnv) return false

    return (containerEnv.EXPLORER_CHECKPOINT_SELF_SYNC !== undefined && containerEnv.EXPLORER_CHECKPOINT_SELF_SYNC !== "") ||
           (containerEnv.HUB_API_URL !== undefined && containerEnv.HUB_API_URL !== "")
}

module.exports = { buildHubModuleConfig, buildCheckpointConfig, isCheckpointSelfSyncEnabled }
