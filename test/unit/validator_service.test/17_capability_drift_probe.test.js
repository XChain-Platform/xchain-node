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

const PUBKEY = 'b'.repeat(64)
const OTHER  = 'c'.repeat(64)

// fs shaped as a validator host: validator.json + signing.key present,
// and capabilities.json carrying whatever DISABLED_CAPABILITIES is passed.
function validatorFs({ settings = makeSettings(PUBKEY, { network: 'testnet' }), disabled = [] } = {}) {
    return makeFs({
        existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
        readFileSync: sinon.stub().callsFake(p => {
            if (p === FAKE_CAPS_FILE) return JSON.stringify({ DISABLED_CAPABILITIES: disabled })
            if (p === FAKE_KEY_FILE) return makeSeedHex()
            return JSON.stringify(settings)
        })
    })
}

// A fake indexer: `sets` maps capability -> array of {pubkey} rows.
// `throwsOn` / `errorOn` / `truncatedOn` bend one capability at a time.
function makeIndexerSdk({ sets = {}, throwsOn, errorOn, truncatedOn, noMethod, lastBlock = 900, statusThrows } = {}) {
    const explorer = {
        getStatus: statusThrows
            ? sinon.stub().rejects(new Error(statusThrows))
            : sinon.stub().resolves({ last_block: { 'bitcoin-testnet': lastBlock } })
    }
    if (!noMethod) {
        explorer.getCapabilityValidators = sinon.stub().callsFake(async ({ capability, block_index }) => {
            if (capability === throwsOn) throw new Error('ECONNREFUSED')
            if (capability === errorOn) return { error: 'capability not configured: ' + capability }
            const validators = sets[capability] || []
            return {
                capability, block_index, count: validators.length,
                truncated: capability === truncatedOn, validators
            }
        })
    }
    return { explorer }
}

function deps(sdk) { return { makeSdk: () => sdk } }

// The probe half of the mispointed-config-dir defect: a host's RESOLVED
// capability set against what the indexer ANSWERS for the same key. Every
// case here is graded on the comparison, never on the mode label alone.
describe('ValidatorService', function () {

    describe('capability-drift probe', function () {

        it('reports no drift when every resolved capability answers IN the set', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price', 'attestation'] })
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }], attestation: [{ pubkey: OTHER }, { pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.drift).to.be.false
            expect(report.alerts).to.deep.equal([])
            expect(vs.capabilityDriftExitCode(report)).to.equal(0)
        })

        it('alerts when a host that resolved standalone is still in a live set', async function () {
            // The defect this row exists for: the config dir lost validator/, the
            // hub came up as a config oracle, and nothing local contradicts it.
            const vs  = loadValidatorService(makeFs())
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }], attestation: [{ pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({ expectPubkey: PUBKEY, network: 'testnet' }, deps(sdk))
            expect(report.resolved.mode).to.equal('standalone')
            expect(report.drift).to.be.true
            expect(report.alerts[0].code).to.equal('resolved-not-validator-but-in-set')
            expect(report.alerts[0].level).to.equal('alert')
            expect(report.alerts[0].message).to.contain(FAKE_VALIDATOR_DIR)
            expect(vs.capabilityDriftExitCode(report)).to.equal(1)
        })

        it('does not alert on a standalone host whose key is in no set: that is a real config oracle', async function () {
            const vs  = loadValidatorService(makeFs())
            const sdk = makeIndexerSdk({ sets: {} })
            const report = await vs.capabilityDriftReport({ expectPubkey: PUBKEY, network: 'testnet' }, deps(sdk))
            expect(report.drift).to.be.false
            expect(report.alerts).to.deep.equal([])
            expect(vs.capabilityDriftExitCode(report)).to.equal(0)
        })

        it('alerts when a resolved validator is in NO capability set', async function () {
            const vs  = loadValidatorService(validatorFs())
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: OTHER }] } })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.drift).to.be.true
            expect(report.alerts.map(a => a.code)).to.deep.equal(['validator-in-no-set'])
            expect(vs.capabilityDriftExitCode(report)).to.equal(1)
        })
    })
})

describe('ValidatorService', function () {

    describe('capability-drift probe', function () {

        it('names each capability the indexer answers absent while this host serves it', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price', 'cross_chain', 'attestation'] })
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }], cross_chain: [{ pubkey: OTHER }], attestation: [{ pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.drift).to.be.true
            expect(report.alerts).to.have.length(1)
            expect(report.alerts[0].code).to.equal('capability-missing-from-set')
            expect(report.alerts[0].capability).to.equal('cross_chain')
            expect(vs.capabilityDriftExitCode(report)).to.equal(1)
        })

        it('never queries a capability the operator opted out of in capabilities.json', async function () {
            // DISABLED_CAPABILITIES means "qualified but not serving", so absence
            // from that set is the configured state rather than drift.
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price', 'cross_chain'] }),
                disabled: ['cross_chain']
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            const queried = sdk.explorer.getCapabilityValidators.getCalls().map(c => c.args[0].capability)
            expect(queried).to.deep.equal(['price'])
            expect(report.drift).to.be.false
        })

        it('treats a TRUNCATED set as unknown, never as "not in the set"', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price'] })
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: OTHER }] }, truncatedOn: 'price' })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.answered.sets.price.unavailable).to.be.true
            expect(report.answered.sets.price).to.not.have.property('inSet')
            expect(report.drift).to.be.null
            expect(report.alerts.map(a => a.level)).to.deep.equal(['warn'])
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })
    })
})

describe('ValidatorService', function () {

    describe('capability-drift probe', function () {

        it('one capability erroring does not hide the answer for the others', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price', 'attestation'] })
            }))
            const sdk = makeIndexerSdk({ sets: { attestation: [{ pubkey: PUBKEY }] }, throwsOn: 'price' })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.answered.sets.price.unavailable).to.be.true
            expect(report.answered.sets.attestation.inSet).to.be.true
            // attestation answered IN, so this is not "in no set"; the unread
            // capability stays a warn and the exit code stays unknown.
            expect(report.alerts.map(a => a.code)).to.deep.equal(['answer-unavailable'])
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })

        it('an indexer error body reads as unknown rather than an empty set', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price'] })
            }))
            const sdk = makeIndexerSdk({ errorOn: 'price' })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.answered.sets.price.unavailable).to.be.true
            expect(report.answered.sets.price.error).to.contain('not configured')
            expect(report.drift).to.be.null
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })

        it('degrades to unknown when the indexer predates the capability-set read', async function () {
            const vs  = loadValidatorService(validatorFs())
            const report = await vs.capabilityDriftReport({}, deps(makeIndexerSdk({ noMethod: true })))
            expect(report.answered.unavailable).to.be.true
            expect(report.answered.reason).to.match(/does not expose/)
            expect(report.alerts.map(a => a.code)).to.deep.equal(['answer-unavailable'])
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })

        it('degrades to unknown when the tip read fails, instead of probing a made-up block', async function () {
            const vs  = loadValidatorService(validatorFs())
            const sdk = makeIndexerSdk({ statusThrows: 'timeout' })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.answered.unavailable).to.be.true
            expect(sdk.explorer.getCapabilityValidators.called).to.be.false
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })
    })
})

describe('ValidatorService', function () {

    describe('capability-drift probe', function () {

        it('settles membership at the block it was handed, when one is given', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price'] })
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({}, { makeSdk: () => sdk, blockIndex: 500 })
            expect(sdk.explorer.getStatus.called).to.be.false
            expect(sdk.explorer.getCapabilityValidators.firstCall.args[0].block_index).to.equal(500)
            expect(report.answered.block).to.equal(500)
        })

        it('says there is nothing to compare, and asks no indexer, when the host has no identity', async function () {
            const vs  = loadValidatorService(makeFs())
            const sdk = makeIndexerSdk({})
            const report = await vs.capabilityDriftReport({ network: 'testnet' }, deps(sdk))
            expect(report.alerts.map(a => a.code)).to.deep.equal(['no-identity'])
            expect(report.answered).to.be.null
            expect(sdk.explorer.getStatus.called).to.be.false
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })

        it('still compares a DISABLED validator, whose key can be staked and in a set', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', enabled: false, capabilities: ['price'] })
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.resolved.mode).to.equal('disabled')
            expect(report.pubkey).to.equal(PUBKEY)
            expect(report.alerts[0].code).to.equal('resolved-not-validator-but-in-set')
        })

        it('matches the answered pubkey case-insensitively', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: 'testnet', capabilities: ['price'] })
            }))
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY.toUpperCase() }] } })
            const report = await vs.capabilityDriftReport({}, deps(sdk))
            expect(report.drift).to.be.false
        })
    })
})

describe('ValidatorService', function () {

    describe('capability-drift probe', function () {

        it('degrades to unknown on an unknown network rather than guessing a coin', async function () {
            const vs  = loadValidatorService(validatorFs({
                settings: makeSettings(PUBKEY, { network: null, capabilities: ['price'] })
            }))
            const report = await vs.capabilityDriftReport({}, deps(makeIndexerSdk({})))
            expect(report.answered.unavailable).to.be.true
            expect(report.answered.reason).to.match(/network unknown/)
            expect(vs.capabilityDriftExitCode(report)).to.equal(2)
        })

        it('renders the resolved side, the answered side and the alert in one report', async function () {
            const vs  = loadValidatorService(makeFs())
            const sdk = makeIndexerSdk({ sets: { price: [{ pubkey: PUBKEY }] } })
            const report = await vs.capabilityDriftReport({ expectPubkey: PUBKEY, network: 'testnet' }, deps(sdk))
            const text = vs.formatCapabilityDrift(report).join('\n')
            expect(text).to.contain('standalone')
            expect(text).to.contain(FAKE_VALIDATOR_DIR)
            expect(text).to.contain('price : IN the set')
            expect(text).to.contain('ALERT')
        })
    })
})
