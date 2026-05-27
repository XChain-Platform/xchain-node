/*********************************************************************
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

function saveCredentials(creds) {
    const dir = getCredentialsDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const filePath = getCredentialsPath()
    fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), { mode: 0o600 })
    try {
        fs.chmodSync(filePath, 0o600)
    } catch {
        // chmod may fail on Windows — file is in user's HOME so still protected by ACL
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
    saveExternalDbConfig
}
