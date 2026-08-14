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

// Generate a real 64-hex Ed25519 seed for tests that need valid crypto
function makeSeedHex() {
    return crypto.randomBytes(32).toString('hex')
}

function loadValidatorService(fsStub) {
    return proxyquire('../../src/services/ValidatorService', {
        'fs': fsStub,
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

        it('returns existing settings without re-writing when already initialized', async function () {
            const existingSettings = makeSettings()
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_SETTINGS_FILE) return JSON.stringify(existingSettings)
                    return ''
                })
            })
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator()
            expect(result).to.deep.equal(existingSettings)
            expect(fs.writeFileSync.called).to.be.false
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

        it('sets ORACLE_EPOCH_START to null when not provided', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator()
            expect(result.ORACLE_EPOCH_START).to.be.null
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

        it('skips capabilities file write when it already exists and force is false', async function () {
            const existingSettings = makeSettings()
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_CAPS_FILE),
                lstatSync:  fileLstat([FAKE_CAPS_FILE])
                // SETTINGS_FILE and KEY_FILE do NOT exist → triggers a fresh init
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            const capsWriteCalls = fs.writeFileSync.getCalls().filter(c => c.args[0] === FAKE_CAPS_FILE)
            expect(capsWriteCalls.length).to.equal(0)
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
                existsSync: sinon.stub().callsFake(p => p === FAKE_VALIDATOR_DIR || p === FAKE_CAPS_DIR)
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator()
            expect(fs.mkdirSync.called).to.be.false
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
})
