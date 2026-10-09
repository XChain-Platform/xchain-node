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

let crypto, XChainService, sidecars

function configure(dependencies) {
    ({ crypto, XChainService, sidecars } = dependencies)
}

async function dbPasswordCanRotate() {
    return true
}

async function getOrCreateHubDbPass() {
    const hubLocalPath = sidecars.hubSidecarPath()
    let pass = await sidecars.readSidecarValue(hubLocalPath, "HUB_DB_PASS")
    if (!pass) {
        pass = crypto.randomBytes(24).toString('hex')
        sidecars.upsertSidecarValues(hubLocalPath, { HUB_DB_PASS: pass })
    }
    return pass
}

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
        if (!defaultConfig["INDEXER_DB_PASS"]) throw new Error("INDEXER_DB_PASS was not generated")
        defaultConfig["HUB_DB_PASS"] = defaultConfig["INDEXER_DB_PASS"]
    }
}

function mergeDefaults(defaultConfig, defaultValues) {
    const hubSeedUrls = "HUB_SEED_URLS" in defaultConfig
        ? defaultConfig.HUB_SEED_URLS
        : defaultValues.HUB_SEED_URLS
    const hasHubSeedUrls = Boolean(hubSeedUrls)
    if (hasHubSeedUrls) delete defaultConfig.HUB_API_URL
    for (const key in defaultValues) {
        if (!(key in defaultConfig) && !(hasHubSeedUrls && key === "HUB_API_URL")) {
            defaultConfig[key] = defaultValues[key]
        }
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
