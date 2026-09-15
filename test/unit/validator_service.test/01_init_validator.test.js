'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
// Fake config dir (never touches the real filesystem)
const FAKE_CONFIG_DIR = '/tmp/test-xchain-config'
const FAKE_VALIDATOR_DIR = path.join(FAKE_CONFIG_DIR, 'validator')
const FAKE_KEY_FILE      = path.join(FAKE_VALIDATOR_DIR, 'signing.key')
const FAKE_SETTINGS_FILE = path.join(FAKE_VALIDATOR_DIR, 'validator.json')
// The capability config lives in its OWN directory: that directory is what the
// hub container bind-mounts, and a single-FILE bind mount breaks `docker cp`
// against the container for every path. signing.key must stay outside it.
const FAKE_CAPS_DIR      = path.join(FAKE_VALIDATOR_DIR, 'hub-caps')
const FAKE_CAPS_FILE     = path.join(FAKE_CAPS_DIR, 'capabilities.json')
// The coin wallets and the DOGE signer the hub mounts. The stake WIF lives in
// wallets.env, OUTSIDE the mounted signer directory, so the hub never sees it.
const FAKE_WALLETS_FILE  = path.join(FAKE_VALIDATOR_DIR, 'wallets.env')
const FAKE_SIGNER_DIR    = path.join(FAKE_VALIDATOR_DIR, 'signer')
const FAKE_SIGNER_FILE   = path.join(FAKE_SIGNER_DIR, 'signer.js')
// What a written wallets.env looks like: the argument of the writeFileSync
// call that targeted it, parsed back into KEY=VALUE.
function writtenWallets(fs) {
    const call = fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_WALLETS_FILE)
    if (!call) return null
    const out = {}
    for (const line of String(call.args[1]).split('\n')) {
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        out[line.substring(0, eq)] = line.substring(eq + 1)
    }
    return out
}
// The shared 0600 sidecar the hub API key lands in. It is NOT under validator/: the key
// belongs to the host (the hub, the local indexer and the shared services all present it),
// while validator/ holds this node's identity.
const FAKE_HUB_SIDECAR = path.join(FAKE_CONFIG_DIR, 'hub.local')
// ConfigService owns the sidecar plumbing and is stubbed here so init never touches a real
// config directory. `generated` mirrors the read-or-generate result the real one returns.
function makeHubApiKeyStub(generated = true) {
    return sinon.stub().resolves({ path: FAKE_HUB_SIDECAR, generated })
}
// The non-minting read a re-run uses. `present` is what the sidecar already holds.
function makeHubApiKeyReadStub(present = false) {
    return sinon.stub().resolves({ path: FAKE_HUB_SIDECAR, present })
}
function loadValidatorService(fsStub, ensureHubApiKey = makeHubApiKeyStub(),
                              readHubApiKey = makeHubApiKeyReadStub()) {
    return proxyquire('../../../src/services/validator_service', {
        'fs': fsStub,
        './config_service': { ensureHubApiKey, readHubApiKey },
        '../config': configStub({
            configDir: FAKE_CONFIG_DIR
        })
    })
}
// Treat every path named here as a regular file for lstat purposes, so the
// layout migration can tell a real config file from the DIRECTORY docker
// auto-creates at a missing bind-mount source.
function fileLstat(paths) {
    return sinon.stub().callsFake(p => {
        if (paths.includes(p)) return { isFile: () => true }
        const err = new Error('ENOENT: ' + p)
        err.code = 'ENOENT'
        throw err
    })
}
function makeFs(overrides = {}) {
    return {
        existsSync:    sinon.stub().returns(false),
        readFileSync:  sinon.stub().returns('{}'),
        writeFileSync: sinon.stub(),
        mkdirSync:     sinon.stub(),
        chmodSync:     sinon.stub(),
        lstatSync:     fileLstat([]),
        renameSync:    sinon.stub(),
        readdirSync:   sinon.stub().returns(['capabilities.json']),
        ...overrides
    }
}
// Build a settings object as would be saved by initValidator
function makeSettings(pubkey = 'a'.repeat(64), opts = {}) {
    return {
        enabled:            true,
        pubkey:             pubkey,
        P2P_VALIDATOR_ADDR: '0.0.0.0:10001',
        P2P_PORT:           10001,
        SEED_NODES:         [],
        ORACLE_EPOCH_START: null,
        capabilities:       ['price', 'cross_chain', 'oracle_publish', 'attestation'],
        ...opts
    }
}

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        // Wallet generation loads the XChain SDK lazily (ValidatorService.loadSdk),
        // and the SDK drags in the secp256k1 and bitcoinjs stack. Whichever test
        // first touches it pays that module-load cost inside its own 2 s mocha
        // budget, which is fine on an idle box and a timeout on a loaded one (the
        // first-run test below flaked that way under the full suite, 2026-09-11).
        // Load it once here, outside any timed test, so the tests time behaviour
        // rather than disk.
        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
        })

        it('writes key, settings, and capabilities files on first run', async function () {
            const fs = makeFs()  // existsSync always false → not initialized
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator()

            const writeCalls = fs.writeFileSync.getCalls().map(c => c.args[0])
            expect(writeCalls).to.include(FAKE_KEY_FILE)
            expect(writeCalls).to.include(FAKE_SETTINGS_FILE)
            expect(writeCalls).to.include(FAKE_CAPS_FILE)

            expect(fs.mkdirSync.calledWith(FAKE_VALIDATOR_DIR, { recursive: true })).to.be.true

            expect(result.enabled).to.be.true
            expect(result.pubkey).to.be.a('string').with.length(64)
            expect(result.capabilities).to.deep.equal(['price', 'cross_chain', 'oracle_publish', 'attestation'])
        })

        it('returns existing settings and never rotates the signing key when already initialized', async function () {
            // network already recorded and wallets already present: nothing to repair.
            const existingSettings = makeSettings(undefined, { network: 'testnet', P2P_PORT: 10002 })
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                lstatSync: fileLstat([FAKE_WALLETS_FILE]),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_SETTINGS_FILE) return JSON.stringify(existingSettings)
                    if (p === FAKE_WALLETS_FILE) return 'NETWORK=testnet\nSTAKE_ADDRESS=mKept\nDOGE_ADDRESS=nKept\n'
                    return ''
                })
            })
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator()
            expect(result).to.deep.equal(existingSettings)
            expect(fs.writeFileSync.called).to.be.false
        })
    })
})

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
        })

        // A validator initialized before wallets existed must be able to get
        // them by re-running init. Making it pass --force (a NEW signing key,
        // a re-stake and another activation wait) would be a punishing upgrade.
        it('repairs a pre-wallets validator on a re-run, without touching the signing key', async function () {
            const existingSettings = makeSettings(undefined, { network: 'testnet', P2P_PORT: 10002 })
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE ? JSON.stringify(existingSettings) : '{}')
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            const w = writtenWallets(fs)
            expect(w, 'wallets were created').to.exist
            expect(w.NETWORK).to.equal('testnet')
            const wrote = fs.writeFileSync.getCalls().map(c => c.args[0])
            expect(wrote, 'signing key untouched').to.not.include(FAKE_KEY_FILE)
            expect(wrote, 'settings untouched (network already recorded)').to.not.include(FAKE_SETTINGS_FILE)
            expect(wrote).to.include(FAKE_SIGNER_FILE)
        })

        it('records the network on a validator.json that predates the field', async function () {
            const old = makeSettings()                       // no `network`, P2P_PORT 10001
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                lstatSync: fileLstat([FAKE_WALLETS_FILE]),   // wallets present, so only the network is repaired
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_SETTINGS_FILE) return JSON.stringify(old)
                    if (p === FAKE_WALLETS_FILE) return 'NETWORK=mainnet\nSTAKE_ADDRESS=1Kept\nDOGE_ADDRESS=DKept\n'
                    return ''
                })
            })
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator()
            expect(result.network).to.equal('mainnet')       // derived from port 10001
            const settingsWrite = fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_SETTINGS_FILE)
            expect(settingsWrite, 'the derived network is persisted').to.exist
            expect(JSON.parse(settingsWrite.args[1]).network).to.equal('mainnet')
        })
    })
})

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
        })

        it('re-generates key with force=true even when already initialized', async function () {
            const existingSettings = makeSettings()
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().returns(JSON.stringify(existingSettings))
            })
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ force: true })
            expect(fs.writeFileSync.called).to.be.true
            expect(result.pubkey).to.not.be.null
        })

        it('sets P2P_PORT from opts.p2pPort', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ p2pPort: '10099' })
            expect(result.P2P_PORT).to.equal(10099)
        })

        it('sets P2P_VALIDATOR_ADDR from opts.p2pAddr', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ p2pAddr: '1.2.3.4:10001' })
            expect(result.P2P_VALIDATOR_ADDR).to.equal('1.2.3.4:10001')
        })

        it('defaults P2P_VALIDATOR_ADDR to 0.0.0.0:<port> when p2pAddr not given', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ p2pPort: 10042 })
            expect(result.P2P_VALIDATOR_ADDR).to.equal('0.0.0.0:10042')
        })

        it('sets SEED_NODES from comma-separated opts.seedNodes', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ seedNodes: 'peer1:10001,peer2:10002' })
            expect(result.SEED_NODES).to.deep.equal(['peer1:10001', 'peer2:10002'])
        })
    })
})
