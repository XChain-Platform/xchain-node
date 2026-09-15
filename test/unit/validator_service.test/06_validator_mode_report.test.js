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

// Pin the three states getValidatorEnv() flattens into {}, since a deploy that
// cannot separate them reports a mispointed config dir as standalone.
describe('ValidatorService', function () {

    describe('validatorModeReport()', function () {

        it('reports validator mode and the directory it resolved from', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().returns(JSON.stringify(makeSettings()))
            })
            const report = loadValidatorService(fs).validatorModeReport()
            expect(report.mode).to.equal('validator')
            expect(report.dir).to.equal(FAKE_VALIDATOR_DIR)
            expect(report.missing).to.deep.equal([])
        })

        it('separates a DISABLED validator from one that was never configured', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p =>
                    p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                readFileSync: sinon.stub().returns(JSON.stringify(makeSettings(undefined, { enabled: false })))
            })
            const report = loadValidatorService(fs).validatorModeReport()
            expect(report.mode).to.equal('disabled')
            expect(report.dir).to.equal(FAKE_VALIDATOR_DIR)
        })

        it('reports standalone, and still names the directory it checked', function () {
            // The directory matters most in exactly this case: a mispointed
            // XCHAIN_NODE_CONFIG_DIR is indistinguishable from a standalone node
            // unless the deploy says where it looked.
            const report = loadValidatorService(makeFs()).validatorModeReport()
            expect(report.mode).to.equal('standalone')
            expect(report.dir).to.equal(FAKE_VALIDATOR_DIR)
            expect(report.missing).to.deep.equal([FAKE_SETTINGS_FILE, FAKE_KEY_FILE])
        })
    })
})

describe('ValidatorService', function () {

    describe('validatorModeReport()', function () {

        it('calls a HALF-present state incomplete, never standalone, and names what is missing', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE),
                readFileSync: sinon.stub().returns(JSON.stringify(makeSettings()))
            })
            const report = loadValidatorService(fs).validatorModeReport()
            expect(report.mode).to.equal('incomplete')
            expect(report.missing).to.deep.equal([FAKE_KEY_FILE])
        })

        it('is incomplete with the key present and the settings gone, the other half of the pair', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_KEY_FILE)
            })
            const report = loadValidatorService(fs).validatorModeReport()
            expect(report.mode).to.equal('incomplete')
            expect(report.missing).to.deep.equal([FAKE_SETTINGS_FILE])
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
    })
})

describe('ValidatorService', function () {

    describe('validatorModeReport()', function () {

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
})
