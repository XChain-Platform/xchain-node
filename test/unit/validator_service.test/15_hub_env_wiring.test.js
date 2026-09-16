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
// The coin wallets and the DOGE signer the hub mounts. The stake WIF lives in
// wallets.env, OUTSIDE the mounted signer directory, so the hub never sees it.
const FAKE_WALLETS_FILE  = path.join(FAKE_VALIDATOR_DIR, 'wallets.env')
const FAKE_SIGNER_DIR    = path.join(FAKE_VALIDATOR_DIR, 'signer')
const FAKE_SIGNER_FILE   = path.join(FAKE_SIGNER_DIR, 'signer.js')
const FAKE_SIGNER_ENV    = path.join(FAKE_SIGNER_DIR, '.env')
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

describe('ValidatorService', function () {

    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        describe('hub env wiring', function () {

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
})
