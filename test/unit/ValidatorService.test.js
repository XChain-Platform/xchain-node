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
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const crypto     = require('crypto')

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
const FAKE_LEGACY_CAPS   = path.join(FAKE_VALIDATOR_DIR, 'capabilities.json')
// The coin wallets and the DOGE signer the hub mounts. The stake WIF lives in
// wallets.env, OUTSIDE the mounted signer directory, so the hub never sees it.
const FAKE_WALLETS_FILE  = path.join(FAKE_VALIDATOR_DIR, 'wallets.env')
const FAKE_SIGNER_DIR    = path.join(FAKE_VALIDATOR_DIR, 'signer')
const FAKE_SIGNER_FILE   = path.join(FAKE_SIGNER_DIR, 'signer.js')
const FAKE_SIGNER_ENV    = path.join(FAKE_SIGNER_DIR, '.env')

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

// Generate a real 64-hex Ed25519 seed for tests that need valid crypto
function makeSeedHex() {
    return crypto.randomBytes(32).toString('hex')
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
    return proxyquire('../../src/services/ValidatorService', {
        'fs': fsStub,
        './ConfigService': { ensureHubApiKey, readHubApiKey },
        '../config/constants': {
            configDir: FAKE_CONFIG_DIR
        }
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

    describe('pubkeyFromSeedHex()', function () {

        it('returns a 64-char hex string', function () {
            const vs = loadValidatorService(makeFs())
            const seed = makeSeedHex()
            const pubkey = vs.pubkeyFromSeedHex(seed)
            expect(pubkey).to.be.a('string').with.length(64)
            expect(pubkey).to.match(/^[a-f0-9]{64}$/)
        })

        it('is deterministic: same seed → same pubkey', function () {
            const vs = loadValidatorService(makeFs())
            const seed = makeSeedHex()
            expect(vs.pubkeyFromSeedHex(seed)).to.equal(vs.pubkeyFromSeedHex(seed))
        })

        it('different seeds → different pubkeys', function () {
            const vs = loadValidatorService(makeFs())
            const pubkey1 = vs.pubkeyFromSeedHex(makeSeedHex())
            const pubkey2 = vs.pubkeyFromSeedHex(makeSeedHex())
            expect(pubkey1).to.not.equal(pubkey2)
        })
    })

    describe('isInitialized()', function () {

        it('returns true when both settings and key files exist', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE)
            })
            const vs = loadValidatorService(fs)
            expect(vs.isInitialized()).to.be.true
        })

        it('returns false when settings file is missing', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_KEY_FILE)
            })
            const vs = loadValidatorService(fs)
            expect(vs.isInitialized()).to.be.false
        })

        it('returns false when key file is missing', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE)
            })
            const vs = loadValidatorService(fs)
            expect(vs.isInitialized()).to.be.false
        })

        it('returns false when neither file exists', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.isInitialized()).to.be.false
        })
    })

    describe('initValidator()', function () {

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

        it('sets ORACLE_EPOCH_START from opts.oracleEpochStart', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ oracleEpochStart: '1717200000000' })
            expect(result.ORACLE_EPOCH_START).to.equal(1717200000000)
        })

        // With no opts the port defaults to 10001, which names the mainnet
        // federation, so the epoch defaults to that federation's ruled value
        // rather than to null. Null is reserved for a port naming no federation.
        it('falls back to the mainnet federation epoch when none is supplied', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator()
            expect(result.ORACLE_EPOCH_START).to.equal(1788220800000)
        })

        it('uses partial capabilities from opts.capabilities', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ capabilities: 'price,attestation' })
            expect(result.capabilities).to.deep.equal(['price', 'attestation'])
        })

        it('writes key file with mode 0600', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            const keyWriteCall = fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_KEY_FILE)
            expect(keyWriteCall).to.exist
            expect(keyWriteCall.args[2]).to.deep.equal({ mode: 0o600 })
        })

        it('leaves an existing, operator-tuned capabilities file alone when force is false', async function () {
            // An operator already set their own publisher address: init fills only
            // placeholders, so nothing in this file is a placeholder and it stays.
            const tuned = JSON.stringify({ oracle_publish: { doge_address: 'DOperatorOwnAddress', doge_wallet: '/their/path' } })
            const fs = makeFs({
                existsSync:   sinon.stub().callsFake(p => p === FAKE_CAPS_FILE),
                lstatSync:    fileLstat([FAKE_CAPS_FILE]),
                readFileSync: sinon.stub().callsFake(p => p === FAKE_CAPS_FILE ? tuned : '{}')
                // SETTINGS_FILE and KEY_FILE do NOT exist → triggers a fresh init
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            const capsWriteCalls = fs.writeFileSync.getCalls().filter(c => c.args[0] === FAKE_CAPS_FILE)
            expect(capsWriteCalls.length).to.equal(0)
        })

        it('fills only the publisher placeholders in an existing capabilities file', async function () {
            const stale = JSON.stringify({
                DISABLED_CAPABILITIES: ['cross_chain'],
                oracle_publish: { doge_address: 'REPLACE_WITH_DOGE_ADDRESS', doge_wallet: 'REPLACE_WITH_DOGE_WALLET_PATH' }
            })
            const fs = makeFs({
                existsSync:   sinon.stub().callsFake(p => p === FAKE_CAPS_FILE),
                lstatSync:    fileLstat([FAKE_CAPS_FILE]),
                readFileSync: sinon.stub().callsFake(p => p === FAKE_CAPS_FILE ? stale : '{}')
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            const capsWriteCalls = fs.writeFileSync.getCalls().filter(c => c.args[0] === FAKE_CAPS_FILE)
            expect(capsWriteCalls.length).to.equal(1)
            const written = JSON.parse(capsWriteCalls[0].args[1])
            expect(written.DISABLED_CAPABILITIES).to.deep.equal(['cross_chain'])
            expect(written.oracle_publish.doge_address).to.match(/^D/)
            expect(written.oracle_publish.doge_wallet).to.equal('/XChainHub/operator-signer/.env')
        })

        it('creates validator dir if it does not exist', async function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => false)
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            expect(fs.mkdirSync.calledWith(FAKE_VALIDATOR_DIR, { recursive: true })).to.be.true
        })

        it('skips validator dir creation if it already exists', async function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_VALIDATOR_DIR || p === FAKE_CAPS_DIR || p === FAKE_SIGNER_DIR ||
                    p === path.join(FAKE_SIGNER_DIR, 'node_modules'))
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            expect(fs.mkdirSync.called).to.be.false
        })

        // A validator-mode hub REFUSES TO BOOT with no HUB_API_KEY, so an init that leaves
        // none behind produces a documented onboarding path ending in a dead node.
        describe('hub API key', function () {

            // Capture output rather than let assertions read the real console: these tests
            // are about what does and does not get printed.
            function captureInit(fs, ensure, read = makeHubApiKeyReadStub(), opts = {}) {
                const logged = []
                const stub = sinon.stub(console, 'log').callsFake(m => logged.push(String(m)))
                return (async () => {
                    try {
                        const vs = loadValidatorService(fs, ensure, read)
                        await vs.initValidator(opts)
                        return logged
                    } finally {
                        stub.restore()
                    }
                })()
            }

            // An already-initialized node: settings and signing key both on disk.
            function initializedFs() {
                return makeFs({
                    existsSync: sinon.stub().callsFake(p =>
                        p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                    readFileSync: sinon.stub().returns(JSON.stringify(makeSettings()))
                })
            }

            it('ensures a hub API key exists as part of init', async function () {
                const ensure = makeHubApiKeyStub()
                await captureInit(makeFs(), ensure)
                expect(ensure.calledOnce).to.be.true
            })

            it('tells the operator WHERE the credential lives', async function () {
                const logged = await captureInit(makeFs(), makeHubApiKeyStub())
                const line = logged.find(l => l.includes('hub API key'))
                expect(line).to.exist
                expect(line).to.include(FAKE_HUB_SIDECAR)
                expect(line).to.include('0600')
            })

            // The value is a credential; a terminal is a scrollback buffer. init only ever
            // receives a path and a boolean, so there is nothing for it to print.
            it('prints no key material, only the path', async function () {
                const ensure = makeHubApiKeyStub()
                const logged = await captureInit(makeFs(), ensure)
                expect(ensure.firstCall.returnValue).to.be.a('promise')
                const output = logged.join('\n')
                expect(output).to.not.match(/HUB_API_KEY=\S/)
            })

            it('reports a pre-existing key as reused rather than claiming a fresh one', async function () {
                const logged = await captureInit(makeFs(), makeHubApiKeyStub(false))
                const line = logged.find(l => l.includes('hub API key'))
                expect(line).to.include('reused')
                expect(line).to.not.include('generated now')
            })

            // A credential APPEARING is as breaking as one disappearing. A hub with no key
            // runs keyless and every consumer pointed at it carries no key either, so a key
            // minted by a re-run 401s all of them on the hub's next deploy while the hub
            // itself still reports healthy. Measured on a regtest host: three indexers
            // dropped off the hub-db sync socket behind a mirror-barrier timeout.
            describe('a re-run over an already-initialized node', function () {

                it('does NOT mint a key on a keyless host', async function () {
                    const ensure = makeHubApiKeyStub()
                    const read   = makeHubApiKeyReadStub(false)
                    await captureInit(initializedFs(), ensure, read)
                    expect(ensure.called).to.be.false
                    expect(read.calledOnce).to.be.true
                })

                it('names the consequence instead of minting silently', async function () {
                    const logged = await captureInit(initializedFs(), makeHubApiKeyStub(), makeHubApiKeyReadStub(false))
                    const output = logged.join('\n')
                    expect(output).to.include('KEYLESS')
                    expect(output).to.include('401')
                    expect(output).to.include('--mint-hub-api-key')
                    expect(output).to.include(FAKE_HUB_SIDECAR)
                })

                // --force rotates the SIGNING KEY, which is this node's business alone. The
                // hub credential is the whole host's, so it stays read-only there too.
                it('does NOT mint under --force either', async function () {
                    const ensure = makeHubApiKeyStub()
                    const read   = makeHubApiKeyReadStub(false)
                    const logged = await captureInit(initializedFs(), ensure, read, { force: true, wallets: false })
                    expect(ensure.called).to.be.false
                    expect(logged.join('\n')).to.include('--mint-hub-api-key')
                })

                it('still reports an existing key, without rotating it', async function () {
                    const ensure = makeHubApiKeyStub()
                    const logged = await captureInit(initializedFs(), ensure, makeHubApiKeyReadStub(true))
                    expect(ensure.called).to.be.false
                    const line = logged.find(l => l.includes('hub API key'))
                    expect(line).to.include(FAKE_HUB_SIDECAR)
                    expect(line).to.include('reused')
                })

                // The old install that really is stuck at a refused hub boot still has a
                // repair path; it is now something the operator asks for by name.
                it('mints when --mint-hub-api-key asks it to', async function () {
                    const ensure = makeHubApiKeyStub()
                    const read   = makeHubApiKeyReadStub(false)
                    const logged = await captureInit(initializedFs(), ensure, read, { mintHubApiKey: true })
                    expect(ensure.calledOnce).to.be.true
                    expect(read.called).to.be.false
                    expect(logged.find(l => l.includes('hub API key'))).to.include('generated now')
                })
            })
        })

        it('creates the capability-config directory and writes the config inside it', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            expect(fs.mkdirSync.calledWith(FAKE_CAPS_DIR, { recursive: true })).to.be.true
            const writes = fs.writeFileSync.getCalls().map(c => c.args[0])
            expect(writes).to.include(FAKE_CAPS_FILE)
            // The signing key stays OUT of the mounted directory: everything in
            // that directory is handed to the hub container.
            expect(writes).to.include(FAKE_KEY_FILE)
            expect(FAKE_KEY_FILE.startsWith(FAKE_CAPS_DIR + path.sep)).to.be.false
        })
    })

    describe('getValidatorSettings()', function () {

        it('returns null when not initialized', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.getValidatorSettings()).to.be.null
        })

        it('returns settings when initialized and enabled=true', function () {
            const settings = makeSettings()
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().returns(JSON.stringify(settings))
            })
            const vs = loadValidatorService(fs)
            expect(vs.getValidatorSettings()).to.deep.equal(settings)
        })

        it('returns null when settings.enabled is false', function () {
            const settings = makeSettings(undefined, { enabled: false })
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().returns(JSON.stringify(settings))
            })
            const vs = loadValidatorService(fs)
            expect(vs.getValidatorSettings()).to.be.null
        })

        it('returns null when readFileSync throws', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            })
            const vs = loadValidatorService(fs)
            expect(vs.getValidatorSettings()).to.be.null
        })

        it('returns null when settings JSON is invalid', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().returns('not-json')
            })
            const vs = loadValidatorService(fs)
            expect(vs.getValidatorSettings()).to.be.null
        })
    })

    describe('getValidatorEnv()', function () {

        it('returns empty object when not initialized', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.getValidatorEnv()).to.deep.equal({})
        })

        it('returns env vars with SIGNING_PRIVKEY_HEX when initialized', function () {
            const fakeSeed = makeSeedHex()
            const settings = makeSettings(undefined, {
                P2P_VALIDATOR_ADDR: '0.0.0.0:10001',
                P2P_PORT: 10001,
                SEED_NODES: ['peer:10001'],
                ORACLE_EPOCH_START: 1717200000000
            })
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_KEY_FILE) return fakeSeed
                    return JSON.stringify(settings)
                })
            })
            const vs = loadValidatorService(fs)
            const env = vs.getValidatorEnv()
            expect(env.SIGNING_PRIVKEY_HEX).to.equal(fakeSeed)
            expect(env.P2P_VALIDATOR_ADDR).to.equal('0.0.0.0:10001')
            expect(env.P2P_PORT).to.equal(10001)
            expect(env.SEED_NODES).to.equal('peer:10001')
            expect(env.ORACLE_EPOCH_START).to.equal(1717200000000)
            expect(env.HUB_CAPABILITY_CONFIG).to.equal('/validator/capabilities.json')
        })

        it('omits ORACLE_EPOCH_START when null', function () {
            const fakeSeed = makeSeedHex()
            const settings = makeSettings(undefined, {
                P2P_VALIDATOR_ADDR: '0.0.0.0:10001',
                P2P_PORT: 10001,
                SEED_NODES: [],
                ORACLE_EPOCH_START: null
            })
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_KEY_FILE) return fakeSeed
                    return JSON.stringify(settings)
                })
            })
            const vs = loadValidatorService(fs)
            const env = vs.getValidatorEnv()
            expect(env).to.not.have.property('ORACLE_EPOCH_START')
        })

        it('joins SEED_NODES array into comma-separated string', function () {
            const fakeSeed = makeSeedHex()
            const settings = makeSettings(undefined, {
                SEED_NODES: ['a:10001', 'b:10002', 'c:10003'],
                ORACLE_EPOCH_START: null
            })
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_KEY_FILE) return fakeSeed
                    return JSON.stringify(settings)
                })
            })
            const vs = loadValidatorService(fs)
            expect(vs.getValidatorEnv().SEED_NODES).to.equal('a:10001,b:10002,c:10003')
        })

        it('handles missing SEED_NODES field gracefully', function () {
            const fakeSeed = makeSeedHex()
            const settings = {
                enabled: true,
                pubkey: 'a'.repeat(64),
                P2P_VALIDATOR_ADDR: '0.0.0.0:10001',
                P2P_PORT: 10001,
                ORACLE_EPOCH_START: null,
                capabilities: ['price']
                // SEED_NODES deliberately omitted
            }
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_KEY_FILE) return fakeSeed
                    return JSON.stringify(settings)
                })
            })
            const vs = loadValidatorService(fs)
            expect(vs.getValidatorEnv().SEED_NODES).to.equal('')
        })
    })

    describe('getCapabilityConfigHostPath()', function () {

        it('returns null when not initialized', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.getCapabilityConfigHostPath()).to.be.null
        })

        it('returns CAPS_FILE path when initialized and caps file exists', function () {
            const settings = makeSettings()
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE || p === FAKE_CAPS_FILE),
                lstatSync: fileLstat([FAKE_CAPS_FILE]),
                readFileSync: sinon.stub().returns(JSON.stringify(settings))
            })
            const vs = loadValidatorService(fs)
            expect(vs.getCapabilityConfigHostPath()).to.equal(FAKE_CAPS_FILE)
        })

        it('returns null when initialized but caps file missing', function () {
            const settings = makeSettings()
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                // FAKE_CAPS_FILE not in the list → returns false
                readFileSync: sinon.stub().returns(JSON.stringify(settings))
            })
            const vs = loadValidatorService(fs)
            expect(vs.getCapabilityConfigHostPath()).to.be.null
        })
    })

    // The hub container's mount. A single-FILE bind mount makes `docker cp`
    // against that container fail for EVERY path with "mkdirat
    // validator/capabilities.json: file exists", because docker recreates each
    // mount destination as a directory during a copy. The fix mounts the
    // containing directory instead - which is only safe while that directory
    // holds nothing but the capability config, since signing.key is the
    // validator's private key.
    describe('getCapabilityConfigMountDir()', function () {

        function initializedFs(extraFiles = []) {
            return makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE || p === FAKE_CAPS_FILE || p === FAKE_CAPS_DIR),
                lstatSync: fileLstat([FAKE_CAPS_FILE]),
                readdirSync: sinon.stub().returns(['capabilities.json', ...extraFiles]),
                readFileSync: sinon.stub().returns(JSON.stringify(makeSettings()))
            })
        }

        it('returns the DIRECTORY holding the capability config, not the file', function () {
            const vs = loadValidatorService(initializedFs())
            expect(vs.getCapabilityConfigMountDir()).to.equal(FAKE_CAPS_DIR)
            expect(vs.getCapabilityConfigMountDir()).to.not.equal(FAKE_CAPS_FILE)
        })

        it('returns null when this node is not a validator', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.getCapabilityConfigMountDir()).to.be.null
        })

        it('REFUSES to hand the hub a directory that also holds the signing key', function () {
            const vs = loadValidatorService(initializedFs(['signing.key']))
            expect(() => vs.getCapabilityConfigMountDir()).to.throw(/signing key MUST NOT be in this directory/)
        })

        it('refuses any other stray file in the mounted directory', function () {
            const vs = loadValidatorService(initializedFs(['validator.json']))
            expect(() => vs.getCapabilityConfigMountDir()).to.throw(/must contain only capabilities\.json.*validator\.json/s)
        })
    })

    describe('capability-config layout migration', function () {

        it('moves a pre-hub-caps capabilities.json into its own directory', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE || p === FAKE_LEGACY_CAPS),
                lstatSync: fileLstat([FAKE_LEGACY_CAPS]),
                readFileSync: sinon.stub().returns(JSON.stringify(makeSettings()))
            })
            const vs = loadValidatorService(fs)
            expect(vs.ensureCapabilityConfigLayout()).to.be.true
            expect(fs.mkdirSync.calledWith(FAKE_CAPS_DIR, { recursive: true })).to.be.true
            expect(fs.renameSync.calledWith(FAKE_LEGACY_CAPS, FAKE_CAPS_FILE)).to.be.true
        })

        it('MOVES rather than copies, so only one config can ever be edited', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_LEGACY_CAPS),
                lstatSync: fileLstat([FAKE_LEGACY_CAPS])
            })
            const vs = loadValidatorService(fs)
            vs.ensureCapabilityConfigLayout()
            expect(fs.renameSync.calledWith(FAKE_LEGACY_CAPS, FAKE_CAPS_FILE), 'must move the file').to.be.true
            // Copying would leave two configs: the operator edits one, the hub
            // reads the other, and the drift is silent.
            expect(fs.writeFileSync.called).to.be.false
            expect(fs.copyFileSync).to.be.undefined
        })

        it('is a no-op once migrated', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_CAPS_FILE),
                lstatSync: fileLstat([FAKE_CAPS_FILE])
            })
            const vs = loadValidatorService(fs)
            expect(vs.ensureCapabilityConfigLayout()).to.be.false
            expect(fs.renameSync.called).to.be.false
        })

        it('does not migrate the empty DIRECTORY docker leaves at a missing mount source', function () {
            // docker auto-creates a missing bind-mount source as a directory, so
            // the legacy path can exist while being no config file at all.
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_LEGACY_CAPS),
                lstatSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_LEGACY_CAPS) return { isFile: () => false }
                    throw new Error('ENOENT')
                })
            })
            const vs = loadValidatorService(fs)
            expect(vs.ensureCapabilityConfigLayout()).to.be.false
            expect(fs.renameSync.called).to.be.false
        })
    })

    describe('container mount points', function () {

        it('keeps the hub-side file path unchanged, so the hub needs no change', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.CAPS_CONTAINER_PATH).to.equal('/validator/capabilities.json')
        })

        it('mounts the container DIRECTORY that path sits in', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.CAPS_CONTAINER_DIR).to.equal('/validator')
            expect(vs.CAPS_CONTAINER_PATH.startsWith(vs.CAPS_CONTAINER_DIR + '/')).to.be.true
        })
    })

    describe('VALIDATOR_DIR', function () {

        it('is configDir/validator', function () {
            const vs = loadValidatorService(makeFs())
            expect(vs.VALIDATOR_DIR).to.equal(FAKE_VALIDATOR_DIR)
        })
    })

    // The two coin wallets init writes: the BTC stake wallet (fees, mints, the
    // STAKE itself) and the DOGE wallet the hub publishes price rounds and
    // anchors from. Real key generation through the SDK, offline; only the
    // filesystem is faked.
    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        it('generates a testnet stake wallet and a testnet DOGE wallet for port 10002', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ p2pPort: '10002' })
            expect(result.network).to.equal('testnet')
            const w = writtenWallets(fs)
            expect(w).to.exist
            expect(w.NETWORK).to.equal('testnet')
            expect(w.STAKE_ADDRESS).to.match(/^[mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/)   // BTC testnet P2PKH
            expect(w.DOGE_ADDRESS).to.match(/^n[a-km-zA-HJ-NP-Z1-9]{33}$/)          // DOGE testnet P2PKH
            expect(w.STAKE_WIF_SECRET).to.be.a('string').with.length.above(50)
            expect(w.DOGE_WIF_SECRET).to.be.a('string').with.length.above(50)
            expect(w.STAKE_PUBKEY_HEX).to.match(/^0[23][0-9a-f]{64}$/)
            expect(w.DOGE_PUBKEY_HEX).to.match(/^0[23][0-9a-f]{64}$/)
        })

        it('writes wallets.env and the signer .env with mode 0600, and the signer module beside it', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const byPath = p => fs.writeFileSync.getCalls().find(c => c.args[0] === p)
            expect(byPath(FAKE_WALLETS_FILE).args[2]).to.deep.equal({ mode: 0o600 })
            expect(byPath(FAKE_SIGNER_ENV).args[2]).to.deep.equal({ mode: 0o600 })
            expect(fs.chmodSync.calledWith(FAKE_WALLETS_FILE, 0o600)).to.be.true
            expect(fs.chmodSync.calledWith(FAKE_SIGNER_ENV, 0o600)).to.be.true
            const signer = byPath(FAKE_SIGNER_FILE)
            expect(signer).to.exist
            expect(signer.args[1]).to.include("require('@dankest-llc/xchain-sdk')")
            expect(signer.args[1]).to.include('async walletSign(psbtHex)')
            expect(signer.args[1]).to.include('async broadcast(payload)')
        })

        it('points the signer at the DOGE wallet and the public testnet encoder', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const w = writtenWallets(fs)
            const env = fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_SIGNER_ENV).args[1]
            expect(env).to.include('DOGE_NETWORK=dogecoin-testnet')
            expect(env).to.include('DOGE_ADDRESS=' + w.DOGE_ADDRESS)
            expect(env).to.include('DOGE_WIF=' + w.DOGE_WIF_SECRET)
            expect(env).to.include('DOGE_ENCODER_URL=https://encoder.xchain.io/TDOGE')
            // The stake key is NOT in the mounted directory.
            expect(env).to.not.include(w.STAKE_WIF_SECRET)
        })

        it('fills oracle_publish in the fresh capabilities file from the DOGE wallet', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const w = writtenWallets(fs)
            const caps = JSON.parse(fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_CAPS_FILE).args[1])
            expect(caps.oracle_publish.doge_address).to.equal(w.DOGE_ADDRESS)
            expect(caps.oracle_publish.doge_wallet).to.equal('/XChainHub/operator-signer/.env')
        })

        it('--network names the federation and picks the matching port', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ network: 'testnet' })
            expect(result.P2P_PORT).to.equal(10002)
            expect(result.network).to.equal('testnet')
            expect(result.SEED_NODES).to.deep.equal(['01','02','03','04','05'].map(n => 'ws://validator' + n + '.xchain.io:10002'))
        })

        it('rejects an unknown --network', async function () {
            const vs = loadValidatorService(makeFs())
            let err = null
            try { await vs.initValidator({ network: 'devnet' }) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/--network must be one of/)
        })

        it('defaults ORACLE_EPOCH_START to the testnet federation value', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10002' })
            expect(result.ORACLE_EPOCH_START).to.equal(1787875200000)
        })

        it('--oracle-epoch-start still overrides the federation default', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10002', oracleEpochStart: '1717200000000' })
            expect(result.ORACLE_EPOCH_START).to.equal(1717200000000)
        })

        it('defaults ORACLE_EPOCH_START to the mainnet federation value', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10001' })
            expect(result.network).to.equal('mainnet')
            expect(result.ORACLE_EPOCH_START).to.equal(1788220800000)
        })

        it('leaves ORACLE_EPOCH_START null when the network is unknown', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10009' })
            expect(result.network).to.be.null
            expect(result.ORACLE_EPOCH_START).to.be.null
        })

        // Both federation defaults must sit in the PAST. A future epoch numbers
        // every round negative and OracleRound drops peer submissions for
        // round < 0, which is the failure testnet paid a federation-wide flag
        // day for on 2026-08-28; mainnet is ruled past up front to avoid it.
        // They must also differ, so a round number never lines up across the
        // two federations.
        it('both federation default epochs are in the past, and differ', async function () {
            const vs = loadValidatorService(makeFs())
            const mainnet = await vs.initValidator({ p2pPort: '10001' })
            const testnet = await vs.initValidator({ p2pPort: '10002', force: true })
            expect(mainnet.ORACLE_EPOCH_START).to.be.a('number').and.to.be.lessThan(Date.now())
            expect(testnet.ORACLE_EPOCH_START).to.be.a('number').and.to.be.lessThan(Date.now())
            expect(mainnet.ORACLE_EPOCH_START).to.not.equal(testnet.ORACLE_EPOCH_START)
        })

        it('skips wallets on a non-standard port and says so, without failing init', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const logged = []
            const stub = sinon.stub(console, 'log').callsFake(m => logged.push(String(m)))
            try { await vs.initValidator({ p2pPort: '10099' }) } finally { stub.restore() }
            expect(writtenWallets(fs)).to.be.null
            expect(logged.some(l => /Wallets skipped: the network is unknown/.test(l))).to.be.true
        })

        it('refuses to import a key when the network is unknown', async function () {
            const vs = loadValidatorService(makeFs())
            process.env.XCHAIN_NODE_STAKE_WIF = 'cV' + 'x'.repeat(50)
            let err = null
            try { await vs.initValidator({ p2pPort: '10099', importStakeKey: true }) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/without knowing the network/)
        })

        it('--no-wallets skips wallet generation entirely', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet', wallets: false })
            expect(writtenWallets(fs)).to.be.null
            const caps = JSON.parse(fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_CAPS_FILE).args[1])
            expect(caps.oracle_publish.doge_address).to.equal('REPLACE_WITH_DOGE_ADDRESS')
        })

        it('imports operator-supplied WIFs from the environment and derives their addresses', async function () {
            // Generate two known keys through the SDK, then hand them to init the
            // way a vanity-address operator would: as WIFs, never as argv.
            const { XChainSDK } = require('@dankest-llc/xchain-sdk')
            const btc  = new XChainSDK({ network: 'bitcoin-testnet' })
            const doge = new XChainSDK({ network: 'dogecoin-testnet' })
            const stakeKey = btc.wallet.generateKeyPair()
            const dogeKey  = doge.wallet.generateKeyPair()
            process.env.XCHAIN_NODE_STAKE_WIF = stakeKey.wif
            process.env.XCHAIN_NODE_DOGE_WIF  = dogeKey.wif

            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const w = writtenWallets(fs)
            expect(w.STAKE_ADDRESS).to.equal(btc.wallet.deriveAddress(stakeKey.publicKey))
            expect(w.STAKE_WIF_SECRET).to.equal(stakeKey.wif)
            expect(w.DOGE_ADDRESS).to.equal(doge.wallet.deriveAddress(dogeKey.publicKey))
            expect(w.DOGE_WIF_SECRET).to.equal(dogeKey.wif)
        })

        it('rejects a WIF from the wrong network', async function () {
            const { XChainSDK } = require('@dankest-llc/xchain-sdk')
            const mainnetKey = new XChainSDK({ network: 'bitcoin-mainnet' }).wallet.generateKeyPair()
            process.env.XCHAIN_NODE_STAKE_WIF = mainnetKey.wif
            const vs = loadValidatorService(makeFs())
            let err = null
            try { await vs.initValidator({ network: 'testnet' }) } catch (e) { err = e }
            expect(err).to.exist
        })

        it('keeps existing wallets across --force (a funded address must not be abandoned silently)', async function () {
            const existing = [
                'NETWORK=testnet', 'STAKE_ADDRESS=mExistingStake', 'STAKE_PUBKEY_HEX=02aa', 'STAKE_WIF_SECRET=cExisting',
                'DOGE_ADDRESS=nExistingDoge', 'DOGE_PUBKEY_HEX=02bb', 'DOGE_WIF_SECRET=cExistingDoge', ''
            ].join('\n')
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                lstatSync:  fileLstat([FAKE_WALLETS_FILE]),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_WALLETS_FILE) return existing
                    if (p === FAKE_SETTINGS_FILE) return JSON.stringify(makeSettings())
                    return '{}'
                })
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator({ force: true, p2pPort: '10002' })
            expect(writtenWallets(fs)).to.be.null
            // The fresh capabilities file (force rewrites it) still names the kept DOGE wallet.
            const caps = JSON.parse(fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_CAPS_FILE).args[1])
            expect(caps.oracle_publish.doge_address).to.equal('nExistingDoge')
        })

        it('--force-wallets replaces them', async function () {
            const existing = 'NETWORK=testnet\nSTAKE_ADDRESS=mExistingStake\nDOGE_ADDRESS=nExistingDoge\n'
            const fs = makeFs({
                lstatSync:    fileLstat([FAKE_WALLETS_FILE]),
                readFileSync: sinon.stub().callsFake(p => p === FAKE_WALLETS_FILE ? existing : '{}')
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator({ p2pPort: '10002', forceWallets: true })
            const w = writtenWallets(fs)
            expect(w).to.exist
            expect(w.STAKE_ADDRESS).to.not.equal('mExistingStake')
        })

        // Docker mounts the parent bind first, then the SDK on top of
        // signer/node_modules. A missing mountpoint under a read-only mount is
        // not a degraded signer, it aborts container creation, so init has to
        // leave the empty directory behind.
        it('creates the node_modules mountpoint the SDK mount lands on', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            expect(fs.mkdirSync.calledWith(path.join(FAKE_SIGNER_DIR, 'node_modules'), { recursive: true })).to.be.true
        })

        it('creates that mountpoint at mount time too, for a config written before it existed', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p !== path.join(FAKE_SIGNER_DIR, 'node_modules')),
                lstatSync:  fileLstat([FAKE_SIGNER_FILE, FAKE_SIGNER_ENV])
            })
            const vs = loadValidatorService(fs)
            expect(vs.getSignerMountDir()).to.equal(FAKE_SIGNER_DIR)
            expect(fs.mkdirSync.calledWith(path.join(FAKE_SIGNER_DIR, 'node_modules'), { recursive: true })).to.be.true
        })

        it('does not claim a signer mount when the signer files are absent', function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            expect(vs.getSignerMountDir()).to.be.null
            expect(fs.mkdirSync.called).to.be.false
        })

        it('publicWalletInfo never carries a WIF', function () {
            const vs = loadValidatorService(makeFs())
            const info = vs.publicWalletInfo({
                NETWORK: 'testnet', STAKE_ADDRESS: 'mA', STAKE_PUBKEY_HEX: '02', STAKE_WIF_SECRET: 'cSECRET',
                DOGE_ADDRESS: 'nB', DOGE_PUBKEY_HEX: '03', DOGE_WIF_SECRET: 'cSECRET2'
            })
            expect(JSON.stringify(info)).to.not.include('SECRET')
            expect(info).to.deep.equal({ network: 'testnet', stakeAddress: 'mA', stakePubkeyHex: '02', dogeAddress: 'nB', dogePubkeyHex: '03' })
        })

        describe('hub env wiring', function () {

            function walletedFs(seed, settings, extra = {}) {
                const wallets = [
                    'NETWORK=testnet', 'STAKE_ADDRESS=mStake', 'STAKE_PUBKEY_HEX=02aa', 'STAKE_WIF_SECRET=cStake',
                    'DOGE_ADDRESS=nDoge', 'DOGE_PUBKEY_HEX=02bb', 'DOGE_WIF_SECRET=cDoge', ''
                ].join('\n')
                return makeFs({
                    existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                    lstatSync:  fileLstat([FAKE_WALLETS_FILE, FAKE_SIGNER_FILE, FAKE_SIGNER_ENV]),
                    readFileSync: sinon.stub().callsFake(p => {
                        if (p === FAKE_KEY_FILE) return seed
                        if (p === FAKE_WALLETS_FILE) return wallets
                        return JSON.stringify(settings)
                    }),
                    ...extra
                })
            }

            it('hands the hub the DOGE publisher address, pubkey, encoder and signer module, never the WIF', function () {
                const seed = makeSeedHex()
                const vs = loadValidatorService(walletedFs(seed, makeSettings(undefined, { network: 'testnet', P2P_PORT: 10002 })))
                const env = vs.getValidatorEnv()
                expect(env.HUB_NETWORK).to.equal('testnet')
                expect(env.DOGE_ADDRESS).to.equal('nDoge')
                expect(env.DOGE_PUBKEY_HEX).to.equal('02bb')
                expect(env.DOGE_ENCODER_URL).to.equal('https://encoder.xchain.io/TDOGE')
                expect(env.HUB_SIGNER_MODULE).to.equal('/XChainHub/operator-signer/signer.js')
                expect(JSON.stringify(env)).to.not.include('cDoge')
                expect(JSON.stringify(env)).to.not.include('cStake')
            })

            it('host env wins over the recorded values', function () {
                process.env.HUB_NETWORK = 'regtest'
                process.env.DOGE_ENCODER_URL = 'http://my-encoder:3113'
                const vs = loadValidatorService(walletedFs(makeSeedHex(), makeSettings(undefined, { network: 'testnet' })))
                const env = vs.getValidatorEnv()
                expect(env).to.not.have.property('HUB_NETWORK')   // passthrough already carries the host value
                expect(env.DOGE_ENCODER_URL).to.equal('http://my-encoder:3113')
            })

            it('an operator-supplied signer directory takes precedence over the generated one', function () {
                process.env.XCHAIN_NODE_HUB_SIGNER_DIR = '/home/op/hub-signer'
                const vs = loadValidatorService(walletedFs(makeSeedHex(), makeSettings(undefined, { network: 'testnet' })))
                expect(vs.getSignerMountDir()).to.be.null
                expect(vs.getValidatorEnv()).to.not.have.property('HUB_SIGNER_MODULE')
            })

            it('a validator without wallets gets no DOGE wiring (pre-wallets install)', function () {
                const seed = makeSeedHex()
                const fs = makeFs({
                    existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                    readFileSync: sinon.stub().callsFake(p => p === FAKE_KEY_FILE ? seed : JSON.stringify(makeSettings()))
                })
                const env = loadValidatorService(fs).getValidatorEnv()
                expect(env).to.not.have.property('DOGE_ADDRESS')
                expect(env).to.not.have.property('HUB_SIGNER_MODULE')
            })
        })
    })

    // ROLLCALL: `validator status` surfaces the DOGE publisher runway in roll
    // calls, whether the configured signer can PUBLISH one (not merely sign
    // it), and this key's BTC-side absence streak from the indexer's
    // getrollcallabsences({source, limit}) read.
    describe('ROLLCALL status reporting', function () {

        describe('rollcallEpochBlocks()', function () {

            it('is 30 on regtest and 1008 on testnet, mainnet, and anything unrecognized', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.rollcallEpochBlocks('regtest')).to.equal(30)
                expect(vs.rollcallEpochBlocks('testnet')).to.equal(1008)
                expect(vs.rollcallEpochBlocks('mainnet')).to.equal(1008)
                expect(vs.rollcallEpochBlocks('devnet')).to.equal(1008)
            })
        })

        describe('rollcallAbsenceStreak()', function () {

            it('returns 0 for an empty list (healthy: no absence on record, not "unknown")', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.rollcallAbsenceStreak([], 30)).to.equal(0)
            })

            it('counts a single absence as a streak of one', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.rollcallAbsenceStreak([{ epoch_height: 100, evicted: 0 }], 30)).to.equal(1)
            })

            it('counts two absences one epoch apart as a streak of two', function () {
                const vs = loadValidatorService(makeFs())
                const rows = [{ epoch_height: 130, evicted: 1 }, { epoch_height: 100, evicted: 0 }]
                expect(vs.rollcallAbsenceStreak(rows, 30)).to.equal(2)
            })

            it('stops the streak at a rolled (present) epoch between two absences, even though only absences are in the array', function () {
                const vs = loadValidatorService(makeFs())
                // 160 -> 130 is one epoch (consecutive); 130 -> 70 is two epochs, so
                // whatever epoch happened at 100 was NOT an absence and breaks the run.
                const rows = [{ epoch_height: 160, evicted: 0 }, { epoch_height: 130, evicted: 0 }, { epoch_height: 70, evicted: 0 }]
                expect(vs.rollcallAbsenceStreak(rows, 30)).to.equal(2)
            })

            it('only counts the run starting at the head of the array, never a streak buried deeper in the history', function () {
                const vs = loadValidatorService(makeFs())
                // A lone, older absence with no adjacent row: even though it is "2
                // consecutive" if paired with something further down, nothing here
                // is adjacent to it, so head-counting gives 1, not a longer run
                // found by scanning the rest of the array.
                const rows = [{ epoch_height: 500, evicted: 0 }, { epoch_height: 100, evicted: 0 }, { epoch_height: 70, evicted: 1 }]
                expect(vs.rollcallAbsenceStreak(rows, 30)).to.equal(1)
            })
        })

        describe('getActiveSignerFile()', function () {

            afterEach(function () { delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR })

            it('prefers an operator-supplied signer directory', function () {
                process.env.XCHAIN_NODE_HUB_SIGNER_DIR = '/home/op/hub-signer'
                const vs = loadValidatorService(makeFs())
                expect(vs.getActiveSignerFile()).to.equal(path.join('/home/op/hub-signer', 'signer.js'))
            })

            it('falls back to the generated signer.js once init has written one', function () {
                const fs = makeFs({ lstatSync: fileLstat([FAKE_SIGNER_FILE, FAKE_SIGNER_ENV]) })
                const vs = loadValidatorService(fs)
                expect(vs.getActiveSignerFile()).to.equal(FAKE_SIGNER_FILE)
            })

            it('is null when no signer is configured at all', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.getActiveSignerFile()).to.be.null
            })
        })

        describe('signerModuleExportsBroadcast()', function () {

            it('recognizes the CLI-generated template shape (object-literal broadcast beside walletSign)', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        '/* broadcast(payload)  -> Promise<{txid}>  optional, replaces the default pipeline */\n' +
                        'module.exports = {\n  async broadcast(payload) { return { txid: "x" } },\n  async walletSign(p) { return "s" }\n};'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.true
            })

            it('recognizes the separate exports.broadcast = assignment form', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        'exports.walletSign = async function (p) { return "s" };\n' +
                        'exports.broadcast = async function (payload) { return { txid: "y" } };'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.true
            })

            it('returns false for a hand-built module that only signs', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns('module.exports = {\n  async walletSign(p) { return "s" }\n};')
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.false
            })

            it('is not fooled by a contract comment BEFORE module.exports that only mentions broadcast', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        '/*\n * walletSign(psbtHex) -> Promise<txHex>   REQUIRED\n' +
                        ' * broadcast(payload)  -> Promise<{txid}>  optional, replaces the default pipeline\n */\n' +
                        'module.exports = {\n  async walletSign(p) { return "s" }\n};'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.false
            })

            it('is not fooled by a TODO comment INSIDE the exports block that mentions broadcast(', function () {
                // Here the misleading text sits AFTER the `module.exports` token, so
                // only stripping comments before the scan (not the tail-scoping alone)
                // keeps this from reading as a real export.
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        'module.exports = {\n' +
                        '  // TODO: implement broadcast(payload) once the HSM supports it\n' +
                        '  async walletSign(p) { return "s" }\n' +
                        '};'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.false
            })

            it('returns null when there is no signer file to check', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.null
            })
        })

        describe('getRollcallStatus()', function () {

            // A fake SDK shaped like the parts the status command touches: the DOGE
            // network's address balance and the BTC network's absence read. Mirrors
            // ValidatorStakeService's test fakes (same sdk.explorer.* shape).
            function makeRollcallSdk({ dogeBalance, dogeThrows, absences, absencesThrows, noAbsencesMethod } = {}) {
                const explorerDoge = {
                    getAddress: dogeThrows
                        ? sinon.stub().rejects(new Error(dogeThrows))
                        : sinon.stub().resolves({ balances: { confirmed: dogeBalance !== undefined ? dogeBalance : '0' } })
                }
                const explorerBtc = {}
                if (!noAbsencesMethod) {
                    explorerBtc.getRollcallAbsences = absencesThrows
                        ? sinon.stub().rejects(new Error(absencesThrows))
                        : sinon.stub().resolves({ absences: absences || [] })
                }
                return { dogeSdk: { explorer: explorerDoge }, btcSdk: { explorer: explorerBtc } }
            }

            const WALLET = { network: 'testnet', stakeAddress: 'mStake', dogeAddress: 'nDoge' }

            function routedMakeSdk(dogeSdk, btcSdk) {
                return sdkNetwork => sdkNetwork === 'dogecoin-testnet' ? dogeSdk : btcSdk
            }

            it('healthy: a DOGE runway, no absences, and a publish-capable signer', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ dogeBalance: '0.03', absences: [] })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk),
                    getActiveSignerFile: () => null
                })
                expect(result.doge).to.deep.equal({ unavailable: false, balance: 0.03, rollcalls: 5 })
                expect(result.absences).to.deep.equal({ unavailable: false, streak: 0, evictedNow: false })
                expect(result.broadcast).to.be.null
            })

            it('a streak of one reads as a warning shot, not an eviction', async function () {
                const vs = loadValidatorService(makeFs())
                const rows = [{ epoch_height: 100, source: 'mStake', close_block: 100, evicted: 0 }]
                const { dogeSdk, btcSdk } = makeRollcallSdk({ absences: rows })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences).to.deep.equal({ unavailable: false, streak: 1, evictedNow: false })
            })

            it('a streak of two with evicted:1 on the head row reads as evicted', async function () {
                const vs = loadValidatorService(makeFs())
                // 1008 BTC blocks apart: one ROLLCALL epoch on testnet, so these two
                // absences are genuinely back-to-back.
                const rows = [
                    { epoch_height: 2016, source: 'mStake', close_block: 2016, evicted: 1 },
                    { epoch_height: 1008, source: 'mStake', close_block: 1008, evicted: 0 }
                ]
                const { dogeSdk, btcSdk } = makeRollcallSdk({ absences: rows })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences.streak).to.equal(2)
                expect(result.absences.evictedNow).to.be.true
            })

            it('degrades to unavailable, never a reassuring zero, when the absence read throws', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ absencesThrows: 'ECONNREFUSED' })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences.unavailable).to.be.true
                expect(result.absences).to.not.have.property('streak')
            })

            it('degrades to unavailable, not "no absences", when the indexer predates this read', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ noAbsencesMethod: true })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences.unavailable).to.be.true
                expect(result.absences.reason).to.match(/does not expose/)
            })

            it('degrades the DOGE runway to unavailable rather than reporting 0 roll calls', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ dogeThrows: 'timeout', absences: [] })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.doge.unavailable).to.be.true
                expect(result.doge).to.not.have.property('rollcalls')
            })

            it('reports a signer with no broadcast export, naming the file, independent of wallet state', async function () {
                const OPERATOR_SIGNER = '/home/op/hub-signer/signer.js'
                const fs = makeFs({
                    lstatSync: fileLstat([OPERATOR_SIGNER]),
                    readFileSync: sinon.stub().returns('module.exports = {\n  async walletSign(p) { return "s" }\n};')
                })
                const vs = loadValidatorService(fs)
                const result = await vs.getRollcallStatus(null, 'testnet', {
                    getActiveSignerFile: () => OPERATOR_SIGNER
                })
                // With no walletInfo, doge/absences stay null but broadcast is still computed:
                // the check has nothing to do with whether wallets exist.
                expect(result.doge).to.be.null
                expect(result.absences).to.be.null
                expect(result.broadcast).to.deep.equal({ file: OPERATOR_SIGNER, exportsBroadcast: false })
            })
        })
    })
})
