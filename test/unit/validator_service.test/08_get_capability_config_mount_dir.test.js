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

// The hub container's mount. A single-FILE bind mount makes `docker cp`
// against that container fail for EVERY path with "mkdirat
// validator/capabilities.json: file exists", because docker recreates each
// mount destination as a directory during a copy. The fix mounts the
// containing directory instead - which is only safe while that directory
// holds nothing but the capability config, since signing.key is the
// validator's private key.
describe('ValidatorService', function () {

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
})
