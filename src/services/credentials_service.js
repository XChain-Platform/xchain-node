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

// Read-modify-write, mirroring saveExternalDbConfig() below: a whole-file
// overwrite here would destroy the sibling `externalDb` block written moments
// earlier in the same provisioning run (uuid:7ed329f7).
function saveCredentials(creds) {
    const dir = getCredentialsDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const filePath = getCredentialsPath()
    const existing = _readCredentialsRaw() || {}
    Object.assign(existing, creds)
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), { mode: 0o600 })
    try {
        fs.chmodSync(filePath, 0o600)
    } catch {
        // chmod may fail on Windows; file is in user's HOME so still protected by ACL
    }
}

// --- External DB config (host-native MariaDB mode) ---
// Stored as a nested `externalDb` object in credentials.json so it sits next
// to the OS-user creds without forcing a separate file. Only populated when
// XCHAIN_NODE_EXTERNAL_DB=1.

function _readCredentialsRaw() {
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
    const raw = _readCredentialsRaw()
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
    const existing = _readCredentialsRaw() || {}
    existing.dbRootPassword = String(password)
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), { mode: 0o600 })
    try { fs.chmodSync(filePath, 0o600) } catch {}
}

function hasExternalDbConfig() {
    const raw = _readCredentialsRaw()
    return !!(raw && raw.externalDb
        && typeof raw.externalDb.host === 'string'
        && typeof raw.externalDb.port === 'number'
        && typeof raw.externalDb.root_user === 'string'
        && typeof raw.externalDb.root_password === 'string')
}

function loadExternalDbConfig() {
    const raw = _readCredentialsRaw()
    if (!raw || !raw.externalDb) return null
    return raw.externalDb
}

function saveExternalDbConfig(cfg) {
    const dir = getCredentialsDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const filePath = getCredentialsPath()
    const existing = _readCredentialsRaw() || {}
    existing.externalDb = {
        host:          String(cfg.host),
        port:          Number(cfg.port),
        root_user:     String(cfg.root_user),
        root_password: String(cfg.root_password)
    }
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), { mode: 0o600 })
    try { fs.chmodSync(filePath, 0o600) } catch {}
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
