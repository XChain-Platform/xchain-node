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
// The capability config lives in its OWN directory: that directory is what the
// hub container bind-mounts, and a single-FILE bind mount breaks `docker cp`
// against the container for every path. signing.key must stay outside it.
const FAKE_CAPS_DIR      = path.join(FAKE_VALIDATOR_DIR, 'hub-caps')
const FAKE_CAPS_FILE     = path.join(FAKE_CAPS_DIR, 'capabilities.json')
const FAKE_SIGNER_DIR    = path.join(FAKE_VALIDATOR_DIR, 'signer')
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

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
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
    })
})

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
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
    })
})

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
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
})
