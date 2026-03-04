/*********************************************************************
 * XChain Node - Shared state & singleton instances
 ********************************************************************/

const { DB_NAME, dataDir, srcDir } = require('./config/constants')
const LevelUpStore      = require('./LevelUpDb.js')
const GitHubDownloader  = require('./GitHubDownloader.js')

// --- Singleton service instances ---
const db              = new LevelUpStore(DB_NAME, dataDir)
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
