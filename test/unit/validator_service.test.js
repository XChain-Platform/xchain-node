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
const { configStub } = require('../helpers/config_stub')
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
    return proxyquire('../../src/services/validator_service', {
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
})
