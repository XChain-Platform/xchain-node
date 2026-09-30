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
 * Config Service Sidecars
 ********************************************************************/

'use strict'

let crypto, fs, path, readline, configDir, preferredSecretEnvName
let foldSecretEnvAliases, deprecatedSecretEnvNames, logger

function configure(dependencies) {
    ({ crypto, fs, path, readline, configDir, preferredSecretEnvName,
        foldSecretEnvAliases, deprecatedSecretEnvNames, logger } = dependencies)
}


// Persist RPC credentials to the untracked <coin>-<network>.local sidecar. A fresh sidecar
// is created with writeFileSync; an existing one is appended to, unless overwrite is set
// (used by the legacy-migration path to replace it outright). The sidecar holds the live
// node RPC user/password, so it is forced to 0600 the same way credentials.json is: without
// an explicit mode the file lands at the process umask (commonly 0644), leaving the RPC
// credentials readable by any local user on the host.
function persistSidecarCreds(localFilePath, creds, { overwrite = false } = {}) {
    const body = Object.keys(creds).map(k => `${k}=${creds[k]}`).join("\n") + "\n"
    if (overwrite || !fs.existsSync(localFilePath)) {
        const dir = path.dirname(localFilePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(localFilePath, body, { mode: 0o600 })
    } else {
        let needsLeadingNewline = false
        try {
            const size = fs.statSync(localFilePath).size
            if (size > 0) {
                const fd = fs.openSync(localFilePath, 'r')
                try {
                    const buf = Buffer.alloc(1)
                    fs.readSync(fd, buf, 0, 1, size - 1)
                    needsLeadingNewline = buf.toString('utf8') !== '\n'
                } finally {
                    fs.closeSync(fd)
                }
            }
        } catch {
            needsLeadingNewline = false
        }
        fs.appendFileSync(localFilePath, needsLeadingNewline ? '\n' + body : body)
    }
    // chmod unconditionally: writeFileSync's mode only applies on create, and an
    // already-existing sidecar (append path, or one written before this fix) keeps its
    // old permissions otherwise.
    try { fs.chmodSync(localFilePath, 0o600) } catch {}
}

// Update specific KEY=VALUE entries in a sidecar while PRESERVING all other keys. Unlike
// persistSidecarCreds({overwrite:true}) (which rewrites the file with only the keys it is
// given), this reads the existing sidecar, overlays the supplied values, and rewrites it
// 0600. Used by the DB-password rotation to set DECODER_DB_PASS/INDEXER_DB_PASS (or
// HUB_DB_PASS) without clobbering the NODE_USER/NODE_PASSWORD already in the sidecar.
function upsertSidecarValues(localFilePath, values) {
    const merged = {}
    if (fs.existsSync(localFilePath)) {
        for (const line of fs.readFileSync(localFilePath, "utf8").split(/\r?\n/)) {
            const eqIndex = line.indexOf("=")
            if (eqIndex > 0) merged[line.substring(0, eqIndex)] = line.substring(eqIndex + 1)
        }
    }
    for (const k in values) {
        // Respect the naming this sidecar already uses. A file the operator
        // renamed to the redaction-safe `*_SECRET` form must not sprout the legacy
        // twin again on the next rotation: two names for one credential is exactly
        // the ambiguity foldSecretEnvAliases() refuses to guess through, so the
        // rotation would leave the stack unable to start. When the legacy name is
        // not on disk either, there is nothing to preserve, so a brand new key goes
        // straight to its redaction-safe name.
        const alias = preferredSecretEnvName(k)
        merged[alias && !(k in merged) ? alias : k] = values[k]
    }
    persistSidecarCreds(localFilePath, merged, { overwrite: true })
}

// Read a single KEY=VALUE from a sidecar file, or undefined if the file or key is absent.
// Uses the same createReadStream + readline path as the main config reader above.
//
// Secret-bearing keys are also accepted under their redaction-safe `*_SECRET` name,
// which wins over the legacy name when both are present and non-empty. Keys
// with no alias (XCHAIN_NODE_BLOCKS_DIR and friends) are unaffected.
async function readSidecarValue(localFilePath, key) {
    if (!fs.existsSync(localFilePath)) return undefined
    const alias = preferredSecretEnvName(key)
    let legacyValue = undefined
    let aliasValue  = undefined
    const stream = fs.createReadStream(localFilePath)
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
        const eqIndex = line.indexOf("=")
        if (eqIndex <= 0) continue
        const lineKey = line.substring(0, eqIndex)
        if (lineKey === key) legacyValue = line.substring(eqIndex + 1)
        else if (alias && lineKey === alias) aliasValue = line.substring(eqIndex + 1)
    }
    if (aliasValue !== undefined && aliasValue !== '') return aliasValue
    return legacyValue
}

// Tell the operator, once per config load, which of their secret-bearing keys sit under a
// name automatic redaction does not match. Better to hear it from your own node
// than from a transcript that printed the value.
function warnDeprecatedSecretNames(config, filePath) {
    for (const { legacy, preferred } of deprecatedSecretEnvNames(config)) {
        logger.warn(`Warning: ${legacy} is a deprecated name that automatic secret redaction does not match; ` +
            `rename it to ${preferred} in ${filePath} (its value prints in full whenever the file is read)`)
    }
}

// Path of the shared hub sidecar. Not per coin/network: the hub is one service on the
// host and its credentials are shared by every stack that talks to it.
function hubSidecarPath() {
    return path.resolve(configDir, "hub.local")
}

/**
 * Make sure this host has a HUB_API_KEY on disk, generating one on first use.
 *
 * A hub refuses to boot with no key unless keyless operation is explicitly declared, so
 * `validator init` has to leave a credential behind or the documented onboarding path
 * ends in a node that cannot start. Read-or-generate against the same shared 0600
 * sidecar the hub DB password uses: one host, one hub credential, and every service
 * that authenticates to this hub reads it from that file.
 *
 * An existing key is REUSED and never rotated, including under `validator init --force`
 * (which regenerates the signing key). The API key is already configured into indexers
 * and explorers that write to this hub, so minting a new one behind their back would
 * 401 all of them.
 *
 * Returns the sidecar PATH and whether it just generated, never the key itself: callers
 * report where the credential lives, and no caller has a reason to print it.
 *
 * @returns {Promise<{path: string, generated: boolean}>}
 */
async function ensureHubApiKey() {
    const sidecarPath = hubSidecarPath()
    const existing = await readSidecarValue(sidecarPath, "HUB_API_KEY")
    if (existing) return { path: sidecarPath, generated: false }
    // 32 bytes: the strength the runbook told operators to mint by hand.
    upsertSidecarValues(sidecarPath, { HUB_API_KEY: crypto.randomBytes(32).toString('hex') })
    return { path: sidecarPath, generated: true }
}

/**
 * Report whether this host already holds a HUB_API_KEY, WITHOUT ever minting one.
 *
 * A credential APPEARING is as breaking as one disappearing. A hub deployed with no key
 * runs keyless (HUB_ALLOW_UNAUTHENTICATED), and every indexer, explorer and shared service
 * pointed at it carries no key either; a key landing in this sidecar flips the hub to
 * authenticated on its next deploy and 401s all of them at once, while the hub itself still
 * looks healthy. So the callers that only need to SAY where the credential lives (a re-run
 * of `validator init` over an already-provisioned node) read through here, and generation
 * stays with the fresh-install path in ensureHubApiKey.
 *
 * @returns {Promise<{path: string, present: boolean}>}
 */
async function readHubApiKey() {
    const sidecarPath = hubSidecarPath()
    const existing = await readSidecarValue(sidecarPath, "HUB_API_KEY")
    return { path: sidecarPath, present: !!existing }
}

// Fill in HUB_API_KEY from the shared sidecar when the host env did not supply one.
// The hub, the co-located indexer and the shared services must all present the SAME
// value or their writes 401 against each other, so they resolve it from one file.
// Host env still wins, and this NEVER mints: generation belongs to `validator init`,
// so a standalone install with no validator stays keyless exactly as before.
async function applyHubApiKeyFromSidecar(target) {
    if (target["HUB_API_KEY"] !== undefined && target["HUB_API_KEY"] !== "") return
    const key = await readSidecarValue(hubSidecarPath(), "HUB_API_KEY")
    if (key) target["HUB_API_KEY"] = key
}

// Read the config file for this coin/network pair. Non-secret operator overrides live
// in the main config file; runtime RPC credentials live in a separate, untracked
// <coin>-<network>.local sidecar so the main file can be diffed/shared without ever
// carrying rpcuser/rpcpassword.
// Track whether the main file still carries credentials so legacy installs can be migrated.
// Recover RPC credentials glued onto the tail of a preceding setting by
// an older appender that wrote NODE_USER=/NODE_PASSWORD= with no leading
// newline (e.g. `DUST_AMOUNT=546NODE_USER=<hex>`). Peel each credential
// off the value tail, password first so a double-glue
// `...NODE_USER=<u>NODE_PASSWORD=<p>` resolves cleanly, so the real value
// is uncorrupted and mainFileHasCreds arms the migration below, which
// relocates the credential to the sidecar and strips it from this file.
// NODE_SECRET is the redaction-safe spelling of NODE_PASSWORD.
// It arms the same migration: a credential in the MAIN config file gets
// relocated to the sidecar whichever name it arrived under.
// Accept every secret-bearing key under its redaction-safe `*_SECRET` name and
// fold it onto the canonical legacy name here, at the one place config enters
// the process, so nothing downstream (container env, DB provisioner, RPC
// connectors) has to learn a second spelling. Runs BEFORE the migration
// and generation steps below, which key off the canonical names.
//
// PER FILE, not on the merged result. Merging first would make a renamed key in
// the sidecar and the legacy key left behind in the main config file look like
// one file contradicting itself, and the "both names, different values" refusal
// would fire on what is really just the ordinary sidecar-wins precedence.
// Credentials from the sidecar take precedence over anything in the main file.
// One-time migration for legacy installs: older versions appended NODE_USER /
// NODE_PASSWORD into the main config file alongside non-secret settings. Move the
// credentials into the sidecar and strip them from the main file so the two never
// share a file again. Existing creds keep working; they are simply relocated.
// Generate and persist to the sidecar whichever RPC credential is missing,
// evaluated PER KEY. The old both-absent (&&) guard meant a partial sidecar (one
// key present, one absent) generated nothing, and the missing half then silently
// resolved to the static "rpc" default via the merge below, leaving a well-known
// default credential on a live stack with no operator signal.
function coinConfigPaths(coin, network) {
    const configFilePath = path.resolve(configDir, `${coin}-${network}`)
    if (!configFilePath.startsWith(path.resolve(configDir) + path.sep) && configFilePath !== path.resolve(configDir)) {
        throw new Error('Config path traversal detected')
    }
    return { configFilePath, localFilePath: configFilePath + ".local" }
}

function readMainConfigLine(defaultConfig, line) {
    const eqIndex = line.indexOf("=")
    if (eqIndex <= 0) return false
    const key = line.substring(0, eqIndex)
    let value = line.substring(eqIndex + 1)
    let hasCredentials = false
    for (const credKey of ["NODE_PASSWORD", "NODE_USER"]) {
        const at = value.indexOf(credKey + "=")
        if (at >= 0) {
            defaultConfig[credKey] = value.substring(at + credKey.length + 1)
            value = value.substring(0, at)
            hasCredentials = true
        }
    }
    defaultConfig[key] = value
    return hasCredentials || key === "NODE_USER" || key === "NODE_PASSWORD" || key === "NODE_SECRET"
}

function normalizeMainConfig(defaultConfig, configFilePath) {
    warnDeprecatedSecretNames(defaultConfig, configFilePath)
    foldSecretEnvAliases(defaultConfig)
}

function readSidecarConfigLine(sidecarConfig, line) {
    const eqIndex = line.indexOf("=")
    if (eqIndex > 0) sidecarConfig[line.substring(0, eqIndex)] = line.substring(eqIndex + 1)
}

function mergeSidecarConfig(defaultConfig, sidecarConfig, localFilePath) {
    warnDeprecatedSecretNames(sidecarConfig, localFilePath)
    Object.assign(defaultConfig, foldSecretEnvAliases(sidecarConfig))
}

function migrateMainCredentials(defaultConfig, configFilePath, localFilePath) {
    const creds = {}
    if ("NODE_USER" in defaultConfig) creds["NODE_USER"] = defaultConfig["NODE_USER"]
    if ("NODE_PASSWORD" in defaultConfig) creds["NODE_PASSWORD"] = defaultConfig["NODE_PASSWORD"]
    persistSidecarCreds(localFilePath, creds, { overwrite: true })
    const remaining = []
    for (const key in defaultConfig) {
        if (key !== "NODE_USER" && key !== "NODE_PASSWORD") remaining.push(`${key}=${defaultConfig[key]}`)
    }
    fs.writeFileSync(configFilePath, remaining.length ? remaining.join("\n") + "\n" : "")
}

function generateRpcCredentials(defaultConfig, localFilePath) {
    const generated = {}
    if (!("NODE_USER" in defaultConfig)) {
        generated["NODE_USER"] = defaultConfig["NODE_USER"] = crypto.randomBytes(12).toString('hex')
    }
    if (!("NODE_PASSWORD" in defaultConfig)) {
        // Absent under NODE_PASSWORD means absent under NODE_SECRET too, since the
        // fold above already collapsed either spelling onto this key. Nothing on
        // disk to preserve, so the new credential goes straight to its
        // redaction-safe name.
        const value = crypto.randomBytes(24).toString('hex')
        defaultConfig["NODE_PASSWORD"] = value
        generated[preferredSecretEnvName("NODE_PASSWORD")] = value
    }
    if (Object.keys(generated).length) persistSidecarCreds(localFilePath, generated)
}

module.exports = {
    configure, persistSidecarCreds, upsertSidecarValues, readSidecarValue,
    warnDeprecatedSecretNames, hubSidecarPath, ensureHubApiKey, readHubApiKey,
    applyHubApiKeyFromSidecar, coinConfigPaths, readMainConfigLine, normalizeMainConfig,
    readSidecarConfigLine, mergeSidecarConfig, migrateMainCredentials, generateRpcCredentials
}
