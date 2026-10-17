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
 * XChain Node - Credentials Service
 * Per-OS-user MariaDB credentials persisted in ~/.xchain-node/credentials.json
 ********************************************************************/

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const crypto = require('crypto')
const { getLogger } = require('../observability/logger')
const logger = getLogger()

const XCHAIN_NODE_DB = "xchain_node"
const CREDENTIALS_DIR_NAME = ".xchain-node"
const CREDENTIALS_FILE_NAME = "credentials.json"

function getCredentialsDir() {
    return path.join(os.homedir(), CREDENTIALS_DIR_NAME)
}

function getCredentialsPath() {
    return path.join(getCredentialsDir(), CREDENTIALS_FILE_NAME)
}

function sanitizeForMariaDb(s) {
    const cleaned = s.replace(/[^a-zA-Z0-9_]/g, '_')
    return cleaned.length > 0 ? cleaned : 'user'
}

function getOsUserDbName() {
    const username = os.userInfo().username
    const sanitized = sanitizeForMariaDb(username)
    const userPart = sanitized.substring(0, 60)
    return XCHAIN_NODE_DB + "_" + userPart
}

function generatePassword(byteLength = 24) {
    return crypto.randomBytes(byteLength).toString('base64url')
}

function hasCredentials() {
    try {
        return fs.existsSync(getCredentialsPath())
    } catch {
        return false
    }
}

function loadCredentials() {
    try {
        const content = fs.readFileSync(getCredentialsPath(), 'utf8')
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed.user === 'string' && typeof parsed.password === 'string') {
            return parsed
        }
        return null
    } catch {
        return null
    }
}

// Read the current document for a save. A missing file is an empty one; any other read
// error throws, because the rename in writeCredentialsAtomic() would replace a file this
// user cannot read, where an in-place write would have refused to open it.
function readCredentialsForUpdate(filePath) {
    let content
    try {
        content = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
        if (err && err.code === 'ENOENT') return {}
        throw err
    }
    let parsed = null
    try { parsed = JSON.parse(content) } catch { parsed = null }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    // Move an unparseable file aside instead of saving over it, so the sibling blocks it held stay recoverable
    const aside = filePath + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
    fs.renameSync(filePath, aside)
    logger.warn(`WARNING: ${filePath} could not be parsed, so it was moved to ${aside} and a new one started. ` +
        'Any stored user/password, dbRootPassword or externalDb entry it held may need recovering from that copy.')
    return {}
}

// Write the whole document to a 0600 sibling temp file, flush it, then rename it over the
// original, so a crash or a full disk mid-write never leaves credentials.json torn.
function writeCredentialsAtomic(filePath, doc) {
    const tmpName = '.' + CREDENTIALS_FILE_NAME + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
    const tmpPath = path.join(path.dirname(filePath), tmpName)
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2), { mode: 0o600, flag: 'wx' })
        const fd = fs.openSync(tmpPath, 'r+')
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(tmpPath, filePath)
    } catch (err) {
        // Leave no temp file behind; the original is untouched until the rename
        try { fs.unlinkSync(tmpPath) } catch { /* never created */ }
        throw err
    }
    try {
        fs.chmodSync(filePath, 0o600)
    } catch {
        // chmod may fail on Windows; file is in user's HOME so still protected by ACL
    }
}

// Read-modify-write, mirroring saveExternalDbConfig() below: a whole-file
// overwrite here would destroy the sibling `externalDb` block written moments
// earlier in the same provisioning run (uuid:7ed329f7).
function saveCredentials(creds) {
    const dir = getCredentialsDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const filePath = getCredentialsPath()
    const existing = readCredentialsForUpdate(filePath)
    Object.assign(existing, creds)
    writeCredentialsAtomic(filePath, existing)
}

// --- External DB config (host-native MariaDB mode) ---
// Stored as a nested `externalDb` object in credentials.json so it sits next
// to the OS-user creds without forcing a separate file. Only populated when
// XCHAIN_NODE_EXTERNAL_DB=1.

function readCredentialsRaw() {
    try {
        const content = fs.readFileSync(getCredentialsPath(), 'utf8')
        return JSON.parse(content)
    } catch {
        return null
    }
}

// --- Bundled-container MariaDB root password ---
// Stored as a flat `dbRootPassword` string in credentials.json (0600). The
// container's MYSQL_ROOT_PASSWORD env is still the preferred source when
// readable; this copy exists so non-interactive runs (cron, ssh BatchMode,
// scripted updates) don't dead-end on the stdin prompt when the container
// was created without that env var (observed on installs whose DB container
// predates the env-injection path). Written whenever a root password is
// accepted, read back as the last non-interactive fallback.

function loadDbRootPassword() {
    const raw = readCredentialsRaw()
    return (raw && typeof raw.dbRootPassword === 'string' && raw.dbRootPassword.length > 0)
        ? raw.dbRootPassword
        : null
}

function saveDbRootPassword(password) {
    const dir = getCredentialsDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const filePath = getCredentialsPath()
    const existing = readCredentialsForUpdate(filePath)
    existing.dbRootPassword = String(password)
    writeCredentialsAtomic(filePath, existing)
}

function hasExternalDbConfig() {
    const raw = readCredentialsRaw()
    return !!(raw && raw.externalDb
        && typeof raw.externalDb.host === 'string'
        && typeof raw.externalDb.port === 'number'
        && typeof raw.externalDb.root_user === 'string'
        && typeof raw.externalDb.root_password === 'string')
}

function loadExternalDbConfig() {
    const raw = readCredentialsRaw()
    if (!raw || !raw.externalDb) return null
    return raw.externalDb
}

function saveExternalDbConfig(cfg) {
    const dir = getCredentialsDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const filePath = getCredentialsPath()
    const existing = readCredentialsForUpdate(filePath)
    existing.externalDb = {
        host:          String(cfg.host),
        port:          Number(cfg.port),
        root_user:     String(cfg.root_user),
        root_password: String(cfg.root_password)
    }
    writeCredentialsAtomic(filePath, existing)
}

module.exports = {
    XCHAIN_NODE_DB,
    getCredentialsDir,
    getCredentialsPath,
    getOsUserDbName,
    generatePassword,
    hasCredentials,
    loadCredentials,
    saveCredentials,
    sanitizeForMariaDb,
    hasExternalDbConfig,
    loadExternalDbConfig,
    saveExternalDbConfig,
    loadDbRootPassword,
    saveDbRootPassword
}
