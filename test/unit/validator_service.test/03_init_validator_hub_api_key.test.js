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

// A validator-mode hub REFUSES TO BOOT with no HUB_API_KEY, so an init that leaves
// none behind produces a documented onboarding path ending in a dead node.
describe('ValidatorService', function () {

    describe('initValidator()', function () {

        before(function () {
            this.timeout(30000)
            require('@dankest-llc/xchain-sdk')
        })

        describe('hub API key', function () {

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
        })
    })
})

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        describe('hub API key', function () {

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
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('initValidator()', function () {

        describe('hub API key', function () {

            describe('a re-run over an already-initialized node', function () {

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
    })
})
