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

// Compile the written template and hand it a stub SDK, so the two-phase
// pipeline can be exercised without a key, an encoder or a network.
function loadEmittedSigner(source, encoder) {
    const mod = { exports: {} }
    vm.runInNewContext(source, {
        require: (id) => {
            if (id === 'path')   return path
            if (id === 'dotenv') return { config: () => ({}) }
            if (id === '@dankest-llc/xchain-sdk') return { XChainSDK: function () {
                this._requireEncoder = () => encoder
                this.wallet = {
                    signPsbt:       () => ({ txHex: 'hex-1', txid: PHASE1 }),
                    signRevealPsbt: () => ({ txHex: 'hex-2', txid: 'e'.repeat(64) })
                }
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

function stubEncoder(overrides) {
    return Object.assign({
        createTx:    async () => ({ psbt: 'psbt-1', encoding: 'P2SH' }),
        broadcastTx: async () => ({ txid: PHASE1 }),
        spendP2sh:   async () => ({ psbt: 'psbt-2' })
    }, overrides || {})
}

// The emitted signer runs both phases of the P2SH encoding, and phase 1 puts
// real DOGE on chain. A failure after that point must not reach the hub looking
// like a clean pre-send failure: the hub would requeue, re-enter broadcast(),
// run createTx over fresh UTXOs and fund the same payload a second time. So the
// template is driven for real here rather than grepped, with the SDK stubbed.
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

            it('is valid JavaScript once the template literal is expanded', async function () {
                const source = await emitSigner()
                expect(() => new vm.Script(source, { filename: 'signer.js' })).to.not.throw()
            })

            it('tags a definitive phase-2 rejection with fundsCommitted and the phase-1 txid', async function () {
                const signer = loadEmittedSigner(await emitSigner(), stubEncoder({
                    spendP2sh: async () => { throw new Error('Encoder RPC error: bad-txns-inputs-missingorspent') }
                }))
                let caught = null
                try { await signer.broadcast('wire') } catch (e) { caught = e }
                expect(caught).to.exist
                expect(caught.fundsCommitted).to.equal(true)
                expect(caught.phase1Txid).to.equal(PHASE1)
                // The SAME object is rethrown: the hub classifies on message and response.
                expect(caught.message).to.equal('Encoder RPC error: bad-txns-inputs-missingorspent')
            })

            it('leaves a pre-funding failure untagged, so the round stays retryable', async function () {
                const signer = loadEmittedSigner(await emitSigner(), stubEncoder({
                    createTx: async () => { throw new Error('Encoder RPC error: no UTXOs available') }
                }))
                let caught = null
                try { await signer.broadcast('wire') } catch (e) { caught = e }
                expect(caught).to.exist
                expect(caught.fundsCommitted).to.equal(undefined)
            })

            it('does not tag a successful two-phase publish', async function () {
                const signer = loadEmittedSigner(await emitSigner(), stubEncoder())
                const res = await signer.broadcast('wire')
                expect(res.phase1_txid).to.equal(PHASE1)
            })
        })
    })
})
