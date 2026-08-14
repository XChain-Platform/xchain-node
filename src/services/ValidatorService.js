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
 * XChain Node - Validator Service
 *
 * Validator-mode onboarding for the xchain-hub. `validator init` generates
 * an Ed25519 signing key and writes the validator config that install/start
 * inject into the hub container so it runs as a full validator (P2P + PBFT +
 * capability staking) instead of a standalone config oracle.
 *
 * Files (under configDir/validator/):
 *   signing.key                 64-hex Ed25519 seed (mode 0600): SIGNING_PRIVKEY_HEX
 *   validator.json              P2P + oracle settings + enabled flag + pubkey
 *   hub-caps/capabilities.json  HUB_CAPABILITY_CONFIG: MIN_STAKE thresholds +
 *                               self-test blocks
 *
 * Why capabilities.json sits in its own `hub-caps/` subdirectory rather than
 * beside the other two: the hub container mounts it, and a SINGLE-FILE bind
 * mount breaks `docker cp` against that container forever. Docker's copy path
 * recreates every mount destination as a directory, so it hits the existing
 * file and aborts the whole operation with
 * "mkdirat validator/capabilities.json: file exists" - for ANY path copied,
 * not just the mounted one. Mounting a DIRECTORY instead has no such problem.
 * The directory that gets mounted must therefore contain the capability config
 * and NOTHING else: mounting `validator/` itself would put signing.key, the
 * validator's private key, inside the hub container. ensureCapabilityConfigLayout()
 * migrates pre-hub-caps installs, and assertCapsDirIsolated() refuses to build
 * the mount if anything else ever lands in that directory.
 *
 * The private key is never logged. Only the PUBLIC key is printed (operators
 * stake to it).
 ********************************************************************/

const fs   = require('fs')
const path = require('path')
const crypto = require('crypto')
const { configDir } = require('../config/constants')

const VALIDATOR_DIR   = path.join(configDir, 'validator')
const KEY_FILE        = path.join(VALIDATOR_DIR, 'signing.key')
const SETTINGS_FILE   = path.join(VALIDATOR_DIR, 'validator.json')

// The ONLY file allowed in CAPS_DIR: that whole directory is bind-mounted into
// the hub container (see the header comment), so anything else added here is
// handed to the hub too.
const CAPS_BASENAME   = 'capabilities.json'
const CAPS_DIR        = path.join(VALIDATOR_DIR, 'hub-caps')
const CAPS_FILE       = path.join(CAPS_DIR, CAPS_BASENAME)

// Where installs before the hub-caps split kept the same file. Migrated on
// first use; never mounted (it is the single-file mount that broke docker cp).
const LEGACY_CAPS_FILE = path.join(VALIDATOR_DIR, CAPS_BASENAME)

// In-container mount points (see ModuleService buildAndUp). The DIRECTORY is
// what gets mounted; the file path the hub reads is unchanged from when the
// file itself was mounted, so no hub-side change is needed.
const CAPS_CONTAINER_DIR  = '/validator'
const CAPS_CONTAINER_PATH = CAPS_CONTAINER_DIR + '/' + CAPS_BASENAME

// ASN.1 DER prefixes for Ed25519 (same as xchain-hub/src/ValidatorIdentity.js),
// so the pubkey we print matches what the hub derives from the same seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_ED25519_PREFIX  = Buffer.from('302a300506032b6570032100', 'hex')

// Derive the 64-hex public key from a 64-hex Ed25519 seed.
function pubkeyFromSeedHex(seedHex) {
    const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')])
    const priv  = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    const spki  = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
    return spki.subarray(SPKI_ED25519_PREFIX.length).toString('hex')
}

// Default capability config. MIN_STAKE thresholds mirror the indexer's
// authoritative governance config; the per-capability blocks satisfy the hub's
// self-tests. Operators tune capabilities.json after init (e.g. real RPC URLs).
function defaultCapabilityConfig(capabilities) {
    const enabled = new Set(capabilities)
    const allCaps = ['price', 'cross_chain', 'oracle_publish', 'attestation']
    return {
        // These MUST equal src/coins/BTC.js STAKING.CAPABILITIES MIN_STAKE
        // (the federation-uniform floors every hub sends the indexer as the
        // qualifying threshold). The hub asserts this at startup and refuses to
        // boot on mainnet/testnet if they diverge; cross_chain was 1000 here vs
        // the canonical 5000 for a while, which is the footgun that assert closes.
        CAPABILITIES: {
            price:          { MIN_STAKE: '1000.00000000' },
            cross_chain:    { MIN_STAKE: '5000.00000000' },
            oracle_publish: { MIN_STAKE: '500.00000000'  },
            attestation:    { MIN_STAKE: '1000.00000000' }
        },
        // Capabilities the operator opted OUT of (qualified but won't serve).
        DISABLED_CAPABILITIES: allCaps.filter(c => !enabled.has(c)),
        // Self-test config blocks (presence-checked by the hub; live probing
        // happens during normal operation).
        price:          { sources: ['coingecko'], fiats: ['USD'] },
        cross_chain:    { chains: { BTC: { rpc: 'http://node:8332' } } },
        oracle_publish: { doge_address: 'REPLACE_WITH_DOGE_ADDRESS', doge_wallet: 'REPLACE_WITH_DOGE_WALLET_PATH' },
        attestation:    { providers: {} }
    }
}

function isInitialized() {
    return fs.existsSync(SETTINGS_FILE) && fs.existsSync(KEY_FILE)
}

// True only for a real regular file (a directory at the same path is not one).
// Docker AUTO-CREATES a missing bind-mount source as a directory, so the legacy
// single-file mount leaves exactly that carcass behind on any host where the
// file was removed: existsSync() alone would call it a config file and migrate
// a directory over the live one.
function isRegularFile(p) {
    try { return fs.lstatSync(p).isFile() } catch { return false }
}

/**
 * Move a pre-hub-caps capabilities.json into its own directory.
 *
 * MIGRATE rather than copy: two files would drift, and the drift is silent
 * (the operator edits the path they know, the container reads the other one),
 * which is the failure class this row exists to remove. After this runs there
 * is exactly ONE capability config on disk.
 *
 * Idempotent, and safe to call on a non-validator node (does nothing).
 */
function ensureCapabilityConfigLayout() {
    const legacyIsFile = isRegularFile(LEGACY_CAPS_FILE)

    if (isRegularFile(CAPS_FILE)) {
        // Already migrated. A legacy file that reappeared (an old install run
        // against the same config dir) is NOT read by anything: say so rather
        // than let an operator tune a file the hub will never see.
        if (legacyIsFile) {
            console.log('WARNING: ignoring stale ' + LEGACY_CAPS_FILE
                + '; the live capability config is ' + CAPS_FILE + ' (delete the stale one)')
        }
        return false
    }

    if (!legacyIsFile) return false

    if (!fs.existsSync(CAPS_DIR)) fs.mkdirSync(CAPS_DIR, { recursive: true })
    fs.renameSync(LEGACY_CAPS_FILE, CAPS_FILE)
    console.log('Moved validator capability config to ' + CAPS_FILE
        + ' (its own directory, so the hub mount cannot break `docker cp`).')
    return true
}

/**
 * Refuse to mount CAPS_DIR if it holds anything but the capability config.
 *
 * The whole directory goes into the hub container, so an extra file here is an
 * unreviewed hand-off to the hub; signing.key landing here would put the
 * validator's PRIVATE KEY in the container. Throwing fails the install loudly:
 * a silent skip would boot a hub with no capability config at all.
 */
function assertCapsDirIsolated() {
    const extra = fs.readdirSync(CAPS_DIR).filter(name => name !== CAPS_BASENAME)
    if (extra.length > 0) {
        throw new Error('refusing to mount ' + CAPS_DIR + ' into the hub container: it must contain only '
            + CAPS_BASENAME + ', found ' + extra.join(', ')
            + '. Move those files back under ' + VALIDATOR_DIR + ' (the signing key MUST NOT be in this directory).')
    }
}

// Generate a key + write all validator files. Idempotent guard via `force`.
async function initValidator(opts = {}) {
    if (isInitialized() && !opts.force) {
        const existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
        console.log('Validator already initialized. Pubkey: ' + existing.pubkey)
        console.log('Re-run with --force to regenerate (this creates a NEW key; you would need to re-stake).')
        return existing
    }

    if (!fs.existsSync(VALIDATOR_DIR)) fs.mkdirSync(VALIDATOR_DIR, { recursive: true })
    if (!fs.existsSync(CAPS_DIR)) fs.mkdirSync(CAPS_DIR, { recursive: true })
    // An init over a pre-hub-caps install must adopt that install's tuned
    // config, not silently start beside it.
    ensureCapabilityConfigLayout()

    const seedHex = crypto.randomBytes(32).toString('hex')
    const pubkey  = pubkeyFromSeedHex(seedHex)

    const capabilities = String(opts.capabilities || 'price,cross_chain,oracle_publish,attestation')
        .split(',').map(s => s.trim()).filter(Boolean)
    const seedNodes = String(opts.seedNodes || '')
        .split(',').map(s => s.trim()).filter(Boolean)

    const p2pPort = parseInt(opts.p2pPort) || 10001
    const settings = {
        enabled:            true,
        pubkey:             pubkey,
        P2P_VALIDATOR_ADDR: opts.p2pAddr || ('0.0.0.0:' + p2pPort),
        P2P_PORT:           p2pPort,
        SEED_NODES:         seedNodes,
        // Oracle round numbering anchor. MUST match across the federation.
        ORACLE_EPOCH_START: opts.oracleEpochStart ? parseInt(opts.oracleEpochStart) : null,
        capabilities:       capabilities
    }

    // Write the secret key first, locked down, and never echo it.
    fs.writeFileSync(KEY_FILE, seedHex, { mode: 0o600 })
    fs.chmodSync(KEY_FILE, 0o600)
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
    if (!fs.existsSync(CAPS_FILE) || opts.force) {
        fs.writeFileSync(CAPS_FILE, JSON.stringify(defaultCapabilityConfig(capabilities), null, 2))
    }

    console.log('')
    console.log('Validator initialized.')
    console.log('  signing key : ' + KEY_FILE + ' (mode 0600, keep this secret and back it up)')
    console.log('  settings    : ' + SETTINGS_FILE)
    console.log('  capabilities: ' + CAPS_FILE)
    console.log('')
    console.log('  PUBKEY (stake XCHAIN to this to qualify capabilities):')
    console.log('    ' + pubkey)
    console.log('')
    if (!settings.ORACLE_EPOCH_START)
        console.log('  NOTE: set ORACLE_EPOCH_START (--oracle-epoch-start <unix-ms>) to the value shared by your federation before running the oracle.')
    if (seedNodes.length === 0)
        console.log('  NOTE: no SEED_NODES set. Add peer addresses (--seed-nodes host:port,...) to join the gossip mesh.')
    console.log('  Edit ' + CAPS_FILE + ' to set real cross_chain RPC + oracle_publish DOGE values, then run: xchain-node install master xchain-hub')
    console.log('')

    return settings
}

// Read persisted validator settings (or null if not initialized / disabled).
function getValidatorSettings() {
    if (!isInitialized()) return null
    try {
        const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
        return s && s.enabled ? s : null
    } catch { return null }
}

// Build the env-var fragment injected into the hub container when validator
// mode is enabled. Returns {} for standalone (no validator configured), so the
// standalone install is byte-for-byte unchanged.
function getValidatorEnv() {
    const s = getValidatorSettings()
    if (!s) return {}
    const env = {
        P2P_VALIDATOR_ADDR: s.P2P_VALIDATOR_ADDR,
        P2P_PORT:           s.P2P_PORT,
        SEED_NODES:         (s.SEED_NODES || []).join(','),
        SIGNING_PRIVKEY_HEX: fs.readFileSync(KEY_FILE, 'utf8').trim(),
        HUB_CAPABILITY_CONFIG: CAPS_CONTAINER_PATH
    }
    if (s.ORACLE_EPOCH_START) env.ORACLE_EPOCH_START = s.ORACLE_EPOCH_START
    return env
}

// Host path of capabilities.json (the file the operator edits), or null.
// Migrates a legacy layout first, so this always names the file the hub reads.
function getCapabilityConfigHostPath() {
    if (!getValidatorSettings()) return null
    ensureCapabilityConfigLayout()
    return isRegularFile(CAPS_FILE) ? CAPS_FILE : null
}

// Host DIRECTORY to bind-mount into the hub container (or null when this node
// is not a validator / has no capability config yet). A directory, not the
// file: a single-file bind mount breaks `docker cp` against the container for
// every path, forever. Verified isolated before it is handed over.
function getCapabilityConfigMountDir() {
    if (!getCapabilityConfigHostPath()) return null
    assertCapsDirIsolated()
    return CAPS_DIR
}

module.exports = {
    initValidator,
    getValidatorSettings,
    getValidatorEnv,
    getCapabilityConfigHostPath,
    getCapabilityConfigMountDir,
    ensureCapabilityConfigLayout,
    isInitialized,
    pubkeyFromSeedHex,
    CAPS_CONTAINER_PATH,
    CAPS_CONTAINER_DIR,
    CAPS_DIR,
    VALIDATOR_DIR
}
