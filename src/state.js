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
 * XChain Node - Shared state & singleton instances
 ********************************************************************/

const { srcDir } = require('./config/constants')
const MariaDbStore      = require('./MariaDbStore.js')
const GitHubDownloader  = require('./GitHubDownloader.js')

// --- Singleton service instances ---
// db starts unconfigured; precheck.js calls db.createDatabase(config) once
// the mariadb container is up and per-OS-user credentials are loaded
const db              = new MariaDbStore()
const gitHubDownloader = new GitHubDownloader(srcDir + "/github_hashes.json")

// --- Mutable shared state ---
let dbRootPassword    = null
let installedModules  = {}
let remoteModuleVersions = {}
let statusUpdated     = false
let lastStatus        = null
let lastPrintedStatus = ""
let verbose           = false

function getDbRootPassword()       { return dbRootPassword }
function setDbRootPassword(val)    { dbRootPassword = val }

function getInstalledModules()     { return installedModules }
function setInstalledModules(val)  { installedModules = val }
function resetInstalledModules()   { installedModules = {} }

function getRemoteModuleVersions()       { return remoteModuleVersions }
function setRemoteModuleVersion(key, val) { remoteModuleVersions[key] = val }

function isStatusUpdated()         { return statusUpdated }
function setStatusUpdated(val)     { statusUpdated = val }

function getLastStatus()           { return lastStatus }
function setLastStatus(val)        { lastStatus = val }

function getLastPrintedStatus()    { return lastPrintedStatus }
function setLastPrintedStatus(val) { lastPrintedStatus = val }
function appendLastPrintedStatus(val) { lastPrintedStatus += val }

function isVerbose()               { return verbose }
function setVerbose(val)           { verbose = val }

module.exports = {
    db,
    gitHubDownloader,
    getDbRootPassword,
    setDbRootPassword,
    getInstalledModules,
    setInstalledModules,
    resetInstalledModules,
    getRemoteModuleVersions,
    setRemoteModuleVersion,
    isStatusUpdated,
    setStatusUpdated,
    getLastStatus,
    setLastStatus,
    getLastPrintedStatus,
    setLastPrintedStatus,
    appendLastPrintedStatus,
    isVerbose,
    setVerbose
}
