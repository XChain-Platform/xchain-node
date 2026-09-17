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
 * Config Service Database Defaults
 ********************************************************************/

'use strict'

let crypto, EXTERNAL_DB, SEP, XChainService, peers, sidecars

function configure(dependencies) {
    ({ crypto, EXTERNAL_DB, SEP, XChainService, peers, sidecars } = dependencies)
}

// Whether a per-install random DB password can actually be APPLIED to the live MariaDB
// account on the next provision. Rotation runs either via the external-DB path (EXTERNAL_DB)
// or by exec-ing into a local MariaDB container; on a native, non-container host neither
// runs, so a generated password would never reach the DB and would desync the sidecar from a
// DB still on the old password (the 2026-06-26 indexer outage). Returns false on any error
// (e.g. docker absent), the safe direction: prefer the static default over a password we
// cannot apply. DatabaseService requires this file at load, so it is read through peers.
async function dbPasswordCanRotate() {
    if (EXTERNAL_DB) return true
    try {
        const { getDatabaseContainerId } = peers.databaseService
        return !!(await getDatabaseContainerId())
    } catch {
        return false
    }
}

// HUB_DB_PASS is a SHARED-service credential: the hub and every coin/network stack that
// connects to the hub DB must present the SAME password, so it cannot be generated per
// coin/network. Resolve it once from a shared 0600 sidecar (config/hub.local), generating
// and persisting it on first use. getDefaultConfig() calls are sequential in the installer,
// so the read-or-generate is not racy in practice.
async function getOrCreateHubDbPass() {
    const hubLocalPath = sidecars.hubSidecarPath()
    let pass = await sidecars.readSidecarValue(hubLocalPath, "HUB_DB_PASS")
    if (!pass) {
        // Only mint a random shared password where the rotation can apply it; otherwise use
        // the static default so the sidecar never diverges from a DB the rotation cannot reach.
        if (await dbPasswordCanRotate()) {
            pass = crypto.randomBytes(24).toString('hex')
            sidecars.upsertSidecarValues(hubLocalPath, { HUB_DB_PASS: pass })
        } else {
            pass = "xchain" + SEP + "password"
        }
    }
    return pass
}

// Generate and persist a per-install password for each per-coin/network DB account
// (decoder, indexer) on first provision, so installs no longer share the static
// default. An operator override in the main config file or the sidecar wins (the merge
// above already loaded those into defaultConfig). Only generate where the next provision
// can rotate the live account to the new value (EXTERNAL_DB or a DB container); on a
// native, non-container host the rotation no-ops, so generating would desync the sidecar
// from the DB and lock the service out (the 2026-06-26 indexer outage). There these fall
// through to the static default in defaultValues, matching the un-rotatable live account.
// The indexer's hub-DB connection reuses its OWN DB account (HUB_DB_NAME/USER are set
// to the indexer's in the indexer block above, on every network including regtest
// since the regtest mirror is armed too), so its hub-DB password must be the
// INDEXER_DB_PASS the container will actually get, not the shared hub password. Set
// it here, before the shared HUB_DB_PASS fallback below, so that fallback sees the
// key already present and skips. An operator override (already in defaultConfig)
// wins. On the non-rotatable path (dbPasswordCanRotate() false, the 2026-06-26
// outage fallback) INDEXER_DB_PASS is still absent here and only lands via the
// static-defaults merge below; mirror that same static default instead of copying
// `undefined`, which would both mismatch the account AND occupy the key so the
// fallback/merge never repaired it (HubDbSync ER_ACCESS_DENIED lockout, #2246). Not
// network-gated: leaving regtest out here while HUB_DB_NAME/USER above point at the
// indexer's own account would hand the armed mirror the WRONG password (the shared
// hub password against the indexer's own DB user), so the mirror this row arms would
// never actually connect.
// HUB_DB_PASS is shared across the hub and every coin/network stack (decoder/indexer
// connect to the hub DB). Resolve it from the shared sidecar (generate on first use)
// unless an operator override already supplied it. Applies to both the coin/network
// callers (HUB_DB_PASS in their defaults) and the shared-service hub caller.
// EXTERNAL_DB: rewrite the DB host/port keys so containerized services
// reach the host-native MariaDB via the bridge gateway instead of the
// docker DNS name "mariadb" (which no longer resolves once the bundled
// container is decommissioned). The DB name/user/pass keys stay as-is;
// those are about the credentials, not the network location.
// Resolve the real external host/port via getExternalDbConfig() (env →
// saved credentials.json → prompt) rather than the load-time
// EXTERNAL_DB_HOST/PORT constants, which only reflect env vars or the
// 127.0.0.1:3306 defaults. Otherwise a host/port saved at the first-run
// prompt is ignored and provisioned containers get *_DB_HOST=127.0.0.1
// (their own loopback), unreachable to the real DB (uuid:52c5b5f1).
// DatabaseService requires this file at load, so it is read through peers.
function generateDatabaseCredentials(defaultConfig, localFilePath) {
    const freshDbCreds = {}
    for (const key of ["DECODER_DB_PASS", "INDEXER_DB_PASS"]) {
        if (!(key in defaultConfig)) {
            const value = crypto.randomBytes(24).toString('hex')
            defaultConfig[key] = value
            freshDbCreds[key] = value
        }
    }
    if (Object.keys(freshDbCreds).length) sidecars.upsertSidecarValues(localFilePath, freshDbCreds)
}

function setIndexerHubPassword(defaultConfig, defaultValues, module) {
    if (module === XChainService.XCHAIN_INDEXER && !("HUB_DB_PASS" in defaultConfig)) {
        defaultConfig["HUB_DB_PASS"] = defaultConfig["INDEXER_DB_PASS"] !== undefined
            ? defaultConfig["INDEXER_DB_PASS"]
            : defaultValues["INDEXER_DB_PASS"]
    }
}

function mergeDefaults(defaultConfig, defaultValues) {
    for (const key in defaultValues) {
        if (!(key in defaultConfig)) defaultConfig[key] = defaultValues[key]
    }
}

function applyExternalDatabase(defaultConfig, externalConfig) {
    const dbHostKeys = ['HUB_DB_HOST', 'DECODER_DB_HOST', 'INDEXER_DB_HOST', 'DATABASE_URL']
    const dbPortKeys = ['HUB_DB_PORT', 'DECODER_DB_PORT', 'INDEXER_DB_PORT', 'DATABASE_PORT']
    for (const key of dbHostKeys) {
        if (key in defaultConfig) defaultConfig[key] = externalConfig.host
    }
    for (const key of dbPortKeys) {
        if (key in defaultConfig) defaultConfig[key] = externalConfig.port
    }
}

module.exports = {
    configure, dbPasswordCanRotate, getOrCreateHubDbPass, generateDatabaseCredentials,
    setIndexerHubPassword, mergeDefaults, applyExternalDatabase
}
