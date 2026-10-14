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
const FAKE_SIGNER_DIR    = path.join(FAKE_VALIDATOR_DIR, 'signer')
const FAKE_SIGNER_FILE   = path.join(FAKE_SIGNER_DIR, 'signer.js')
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

const vm     = require('vm')
const PHASE1 = 'f'.repeat(64)
const REVEAL = 'e'.repeat(64)

// Compile the written template and hand it a stub SDK, so the two-phase
// pipeline can be exercised without a key, an encoder or a network. `wallet`
// replaces the stub signing methods.
function loadEmittedSigner(source, encoder, wallet) {
    const mod = { exports: {} }
    vm.runInNewContext(source, {
        require: (id) => {
            if (id === 'path')   return path
            if (id === 'dotenv') return { config: () => ({}) }
            if (id === '@dankest-llc/xchain-sdk') return { XChainSDK: function () {
                this.requireEncoder = () => encoder
                this.wallet = Object.assign({
                    signPsbt:       () => ({ txHex: 'hex-1', txid: PHASE1 }),
                    signRevealPsbt: () => ({ txHex: 'hex-2', txid: REVEAL })
                }, wallet || {})
            } }
            throw new Error('unexpected require in the emitted signer: ' + id)
        },
        module: mod, exports: mod.exports, __dirname: FAKE_SIGNER_DIR, console,
        process: { env: {
            DOGE_NETWORK:     'dogecoin-testnet',
            DOGE_WIF:         'test-wif',
            DOGE_ADDRESS:     'test-address',
            DOGE_ENCODER_URL: 'http://encoder.invalid'
        } },
        Number, String, Error, Promise, Object
    }, { filename: 'signer.js' })
    return mod.exports
}

async function emitSigner() {
    const fs = makeFs()
    const vs = loadValidatorService(fs)
    await vs.initValidator({ network: 'testnet' })
    return fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_SIGNER_FILE).args[1]
}

// An encoder and wallet whose every call is recorded in order, with the
// broadcast that `failBroadcast` names (1 = the commit, 2 = the reveal) refused
// by the node.
function recordingSigner(source, { encoding = 'P2SH', failBroadcast = 0, encoder = {}, wallet = {} } = {}) {
    const calls = []
    let broadcasts = 0
    const record = (name, fn) => async (...args) => { calls.push(name); return fn(...args) }
    const signer = loadEmittedSigner(source, {
        createTx:    record('createTx', encoder.createTx || (async () => ({ psbt: 'psbt-1', encoding }))),
        spendP2sh:   record('spendP2sh', encoder.spendP2sh || (async () => ({ psbt: 'psbt-2' }))),
        broadcastTx: async (hex) => {
            calls.push('broadcast:' + hex)
            broadcasts += 1
            if (broadcasts === failBroadcast) throw new Error('Encoder RPC error: min relay fee not met')
            return { txid: broadcasts === 1 ? PHASE1 : REVEAL }
        }
    }, {
        signPsbt: (...args) => {
            calls.push('sign')
            return (wallet.signPsbt || (() => ({ txHex: 'hex-1', txid: PHASE1 })))(...args)
        },
        signRevealPsbt: (...args) => {
            calls.push('sign-reveal')
            return (wallet.signRevealPsbt || (() => ({ txHex: 'hex-2', txid: REVEAL })))(...args)
        }
    })
    return { signer, calls }
}

async function rejection(promise) {
    try { await promise } catch (e) { return e }
    throw new Error('expected the publish to fail')
}

function stubEncoder(overrides) {
    return Object.assign({
        createTx:    async () => ({ psbt: 'psbt-1', encoding: 'P2SH' }),
        broadcastTx: async () => ({ txid: PHASE1 }),
        spendP2sh:   async () => ({ psbt: 'psbt-2' })
    }, overrides || {})
}

// Each case is a named step, so the suite below reads as the list of what the
// emitted signer guarantees.
const cases = {
    async validJs() {
        const source = await emitSigner()
        expect(() => new vm.Script(source, { filename: 'signer.js' })).to.not.throw()
    },

    async revealRejected() {
        let broadcasts = 0
        const signer = loadEmittedSigner(await emitSigner(), stubEncoder({
            broadcastTx: async () => {
                broadcasts += 1
                if (broadcasts === 2) throw new Error('Encoder RPC error: bad-txns-inputs-missingorspent')
                return { txid: PHASE1 }
            }
        }))
        const caught = await rejection(signer.broadcast('wire'))
        expect(caught).to.include({ fundsCommitted: true, phase1Txid: PHASE1, revealTxid: REVEAL, revealTxHex: 'hex-2' })
        expect(caught.neverSent).to.equal(undefined)
        // The SAME object is rethrown: the hub classifies on message and response.
        expect(caught.message).to.equal('Encoder RPC error: bad-txns-inputs-missingorspent')
    },

    async preFundingFailure() {
        const signer = loadEmittedSigner(await emitSigner(), stubEncoder({
            createTx: async () => { throw new Error('Encoder RPC error: no UTXOs available') }
        }))
        const caught = await rejection(signer.broadcast('wire'))
        expect(caught.fundsCommitted).to.equal(undefined)
        expect(caught.neverSent).to.equal(true)
    },

    async twoPhaseSuccess() {
        const signer = loadEmittedSigner(await emitSigner(), stubEncoder())
        const res = await signer.broadcast('wire')
        expect(res.phase1_txid).to.equal(PHASE1)
    },

    async encoderRefusesReveal() {
        const { signer, calls } = recordingSigner(await emitSigner(), { encoder: {
            spendP2sh: async () => { throw new Error('Encoder RPC error: reveal leg below dust') }
        } })
        const caught = await rejection(signer.broadcast('wire'))
        expect(calls).to.deep.equal(['createTx', 'sign', 'spendP2sh'])
        expect(caught.neverSent).to.equal(true)
        expect(caught.fundsCommitted).to.equal(undefined)
        expect(caught.message).to.equal('Encoder RPC error: reveal leg below dust')
    },

    async revealUnsignable() {
        const { signer, calls } = recordingSigner(await emitSigner(), { wallet: {
            signRevealPsbt: () => { throw new Error('Reveal PSBT finalization failed') }
        } })
        const caught = await rejection(signer.broadcast('wire'))
        expect(calls).to.deep.equal(['createTx', 'sign', 'spendP2sh', 'sign-reveal'])
        expect(caught.neverSent).to.equal(true)
        expect(caught.fundsCommitted).to.equal(undefined)
    },

    async revealBuiltFirst() {
        let spendParams = null
        const { signer, calls } = recordingSigner(await emitSigner(), { encoder: {
            spendP2sh: async (p) => { spendParams = p; return { psbt: 'psbt-2' } }
        } })
        const res = await signer.broadcast('wire')
        expect(calls).to.deep.equal(['createTx', 'sign', 'spendP2sh', 'sign-reveal', 'broadcast:hex-1', 'broadcast:hex-2'])
        expect(spendParams).to.include({ p2shHash: PHASE1, p2shHex: 'hex-1', data: 'wire', encoding: 'P2SH' })
        expect(res).to.deep.equal({ txid: REVEAL, phase1_txid: PHASE1 })
    },

    async revealBroadcastFails() {
        const { signer, calls } = recordingSigner(await emitSigner(), { failBroadcast: 2 })
        const caught = await rejection(signer.broadcast('wire'))
        expect(calls).to.deep.equal(['createTx', 'sign', 'spendP2sh', 'sign-reveal', 'broadcast:hex-1', 'broadcast:hex-2'])
        expect(caught).to.include({ fundsCommitted: true, phase1Txid: PHASE1, revealTxid: REVEAL, revealTxHex: 'hex-2' })
        expect(caught.neverSent).to.equal(undefined)
    },

    async commitBroadcastFails() {
        const { signer, calls } = recordingSigner(await emitSigner(), { failBroadcast: 1 })
        const caught = await rejection(signer.broadcast('wire'))
        expect(calls).to.deep.equal(['createTx', 'sign', 'spendP2sh', 'sign-reveal', 'broadcast:hex-1'])
        expect(caught.neverSent).to.equal(undefined)
        expect(caught.fundsCommitted).to.equal(undefined)
    },

    async singleTransaction() {
        const { signer, calls } = recordingSigner(await emitSigner(), { encoding: 'OP_RETURN' })
        const res = await signer.broadcast('wire')
        expect(calls).to.deep.equal(['createTx', 'sign', 'broadcast:hex-1'])
        expect(res).to.deep.equal({ txid: PHASE1 })
    }
}

// The emitted signer runs both phases of the P2SH encoding, and phase 1 puts
// real DOGE on chain. A failure after that point must not reach the hub looking
// like a clean pre-send failure: the hub would requeue, re-enter broadcast(),
// run createTx over fresh UTXOs and fund the same payload a second time. So the
// template is driven for real here rather than grepped, with the SDK stubbed.
//
// A P2SH commit whose reveal is then refused leaves its legs locked to a script
// only that reveal spends, and the hub dead-letters such a round rather than
// fund it again. So the reveal is built from the signed commit and signed before
// the commit is broadcast, and a refusal there sends nothing.
describe('ValidatorService', function () {

    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        describe('the emitted signer marks post-funding failures', function () {
            it('is valid JavaScript once the template literal is expanded', cases.validJs)
            it('tags a definitive phase-2 rejection with fundsCommitted, the phase-1 txid and the signed reveal', cases.revealRejected)
            it('marks a pre-funding failure neverSent and not fundsCommitted, so the round stays retryable', cases.preFundingFailure)
            it('does not tag a successful two-phase publish', cases.twoPhaseSuccess)
        })

        describe('the emitted signer builds and signs the reveal before the commit broadcast', function () {
            it('broadcasts nothing when the encoder refuses the reveal', cases.encoderRefusesReveal)
            it('broadcasts nothing when the reveal cannot be signed', cases.revealUnsignable)
            it('builds the reveal from the signed commit, then broadcasts the commit and the reveal', cases.revealBuiltFirst)
            it('hands back the signed reveal when its broadcast fails after the commit', cases.revealBroadcastFails)
            it('leaves a commit broadcast failure untagged for the hub to classify', cases.commitBroadcastFails)
            it('builds no reveal for a single-transaction encoding', cases.singleTransaction)
        })
    })
})
