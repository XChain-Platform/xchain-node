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
const FAKE_SIGNER_ENV    = path.join(FAKE_SIGNER_DIR, '.env')
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

// A fake SDK shaped like the parts the status command touches: the DOGE
// network's address balance and the BTC network's absence read. Mirrors
// ValidatorStakeService's test fakes (same sdk.explorer.* shape).
function makeRollcallSdk({ dogeBalance, dogeThrows, absences, absencesThrows, noAbsencesMethod } = {}) {
    const explorerDoge = {
        getAddress: dogeThrows
            ? sinon.stub().rejects(new Error(dogeThrows))
            : sinon.stub().resolves({ balances: { confirmed: dogeBalance !== undefined ? dogeBalance : '0' } })
    }
    const explorerBtc = {}
    if (!noAbsencesMethod) {
        explorerBtc.getRollcallAbsences = absencesThrows
            ? sinon.stub().rejects(new Error(absencesThrows))
            : sinon.stub().resolves({ absences: absences || [] })
    }
    return { dogeSdk: { explorer: explorerDoge }, btcSdk: { explorer: explorerBtc } }
}

const WALLET = { network: 'testnet', stakeAddress: 'mStake', dogeAddress: 'nDoge' }

function routedMakeSdk(dogeSdk, btcSdk) {
    return sdkNetwork => sdkNetwork === 'dogecoin-testnet' ? dogeSdk : btcSdk
}

// ROLLCALL: `validator status` surfaces the DOGE publisher runway in roll
// calls, whether the configured signer can PUBLISH one (not merely sign
// it), and this key's BTC-side absence streak from the indexer's
// getrollcallabsences({source, limit}) read.
describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('rollcallEpochBlocks()', function () {

            it('is 30 on regtest and 1008 on testnet, mainnet, and anything unrecognized', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.rollcallEpochBlocks('regtest')).to.equal(30)
                expect(vs.rollcallEpochBlocks('testnet')).to.equal(1008)
                expect(vs.rollcallEpochBlocks('mainnet')).to.equal(1008)
                expect(vs.rollcallEpochBlocks('devnet')).to.equal(1008)
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('rollcallAbsenceStreak()', function () {

            it('returns 0 for an empty list (healthy: no absence on record, not "unknown")', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.rollcallAbsenceStreak([], 30)).to.equal(0)
            })

            it('counts a single absence as a streak of one', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.rollcallAbsenceStreak([{ epoch_height: 100, evicted: 0 }], 30)).to.equal(1)
            })

            it('counts two absences one epoch apart as a streak of two', function () {
                const vs = loadValidatorService(makeFs())
                const rows = [{ epoch_height: 130, evicted: 1 }, { epoch_height: 100, evicted: 0 }]
                expect(vs.rollcallAbsenceStreak(rows, 30)).to.equal(2)
            })

            it('stops the streak at a rolled (present) epoch between two absences, even though only absences are in the array', function () {
                const vs = loadValidatorService(makeFs())
                // 160 -> 130 is one epoch (consecutive); 130 -> 70 is two epochs, so
                // whatever epoch happened at 100 was NOT an absence and breaks the run.
                const rows = [{ epoch_height: 160, evicted: 0 }, { epoch_height: 130, evicted: 0 }, { epoch_height: 70, evicted: 0 }]
                expect(vs.rollcallAbsenceStreak(rows, 30)).to.equal(2)
            })

            it('only counts the run starting at the head of the array, never a streak buried deeper in the history', function () {
                const vs = loadValidatorService(makeFs())
                // A lone, older absence with no adjacent row: even though it is "2
                // consecutive" if paired with something further down, nothing here
                // is adjacent to it, so head-counting gives 1, not a longer run
                // found by scanning the rest of the array.
                const rows = [{ epoch_height: 500, evicted: 0 }, { epoch_height: 100, evicted: 0 }, { epoch_height: 70, evicted: 1 }]
                expect(vs.rollcallAbsenceStreak(rows, 30)).to.equal(1)
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('getActiveSignerFile()', function () {

            afterEach(function () { delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR })

            it('prefers an operator-supplied signer directory', function () {
                process.env.XCHAIN_NODE_HUB_SIGNER_DIR = '/home/op/hub-signer'
                const vs = loadValidatorService(makeFs())
                expect(vs.getActiveSignerFile()).to.equal(path.join('/home/op/hub-signer', 'signer.js'))
            })

            it('falls back to the generated signer.js once init has written one', function () {
                const fs = makeFs({ lstatSync: fileLstat([FAKE_SIGNER_FILE, FAKE_SIGNER_ENV]) })
                const vs = loadValidatorService(fs)
                expect(vs.getActiveSignerFile()).to.equal(FAKE_SIGNER_FILE)
            })

            it('is null when no signer is configured at all', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.getActiveSignerFile()).to.be.null
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('signerModuleExportsBroadcast()', function () {

            it('recognizes the CLI-generated template shape (object-literal broadcast beside walletSign)', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        '/* broadcast(payload)  -> Promise<{txid}>  optional, replaces the default pipeline */\n' +
                        'module.exports = {\n  async broadcast(payload) { return { txid: "x" } },\n  async walletSign(p) { return "s" }\n};'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.true
            })

            it('recognizes the separate exports.broadcast = assignment form', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        'exports.walletSign = async function (p) { return "s" };\n' +
                        'exports.broadcast = async function (payload) { return { txid: "y" } };'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.true
            })

            it('returns false for a hand-built module that only signs', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns('module.exports = {\n  async walletSign(p) { return "s" }\n};')
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.false
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('signerModuleExportsBroadcast()', function () {

            it('is not fooled by a contract comment BEFORE module.exports that only mentions broadcast', function () {
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        '/*\n * walletSign(psbtHex) -> Promise<txHex>   REQUIRED\n' +
                        ' * broadcast(payload)  -> Promise<{txid}>  optional, replaces the default pipeline\n */\n' +
                        'module.exports = {\n  async walletSign(p) { return "s" }\n};'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.false
            })

            it('is not fooled by a TODO comment INSIDE the exports block that mentions broadcast(', function () {
                // Here the misleading text sits AFTER the `module.exports` token, so
                // only stripping comments before the scan (not the tail-scoping alone)
                // keeps this from reading as a real export.
                const fs = makeFs({
                    lstatSync: fileLstat([FAKE_SIGNER_FILE]),
                    readFileSync: sinon.stub().returns(
                        'module.exports = {\n' +
                        '  // TODO: implement broadcast(payload) once the HSM supports it\n' +
                        '  async walletSign(p) { return "s" }\n' +
                        '};'
                    )
                })
                const vs = loadValidatorService(fs)
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.false
            })

            it('returns null when there is no signer file to check', function () {
                const vs = loadValidatorService(makeFs())
                expect(vs.signerModuleExportsBroadcast(FAKE_SIGNER_FILE)).to.be.null
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('getRollcallStatus()', function () {

            it('healthy: a DOGE runway, no absences, and a publish-capable signer', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ dogeBalance: '0.03', absences: [] })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk),
                    getActiveSignerFile: () => null
                })
                expect(result.doge).to.deep.equal({ unavailable: false, balance: 0.03, rollcalls: 5 })
                expect(result.absences).to.deep.equal({ unavailable: false, streak: 0, evictedNow: false })
                expect(result.broadcast).to.be.null
            })

            it('a streak of one reads as a warning shot, not an eviction', async function () {
                const vs = loadValidatorService(makeFs())
                const rows = [{ epoch_height: 100, source: 'mStake', close_block: 100, evicted: 0 }]
                const { dogeSdk, btcSdk } = makeRollcallSdk({ absences: rows })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences).to.deep.equal({ unavailable: false, streak: 1, evictedNow: false })
            })

            it('a streak of two with evicted:1 on the head row reads as evicted', async function () {
                const vs = loadValidatorService(makeFs())
                // 1008 BTC blocks apart: one ROLLCALL epoch on testnet, so these two
                // absences are genuinely back-to-back.
                const rows = [
                    { epoch_height: 2016, source: 'mStake', close_block: 2016, evicted: 1 },
                    { epoch_height: 1008, source: 'mStake', close_block: 1008, evicted: 0 }
                ]
                const { dogeSdk, btcSdk } = makeRollcallSdk({ absences: rows })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences.streak).to.equal(2)
                expect(result.absences.evictedNow).to.be.true
            })
        })
    })
})

describe('ValidatorService', function () {

    describe('ROLLCALL status reporting', function () {

        describe('getRollcallStatus()', function () {

            it('degrades to unavailable, never a reassuring zero, when the absence read throws', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ absencesThrows: 'ECONNREFUSED' })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences.unavailable).to.be.true
                expect(result.absences).to.not.have.property('streak')
            })

            it('degrades to unavailable, not "no absences", when the indexer predates this read', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ noAbsencesMethod: true })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.absences.unavailable).to.be.true
                expect(result.absences.reason).to.match(/does not expose/)
            })

            it('degrades the DOGE runway to unavailable rather than reporting 0 roll calls', async function () {
                const vs = loadValidatorService(makeFs())
                const { dogeSdk, btcSdk } = makeRollcallSdk({ dogeThrows: 'timeout', absences: [] })
                const result = await vs.getRollcallStatus(WALLET, 'testnet', {
                    makeSdk: routedMakeSdk(dogeSdk, btcSdk), getActiveSignerFile: () => null
                })
                expect(result.doge.unavailable).to.be.true
                expect(result.doge).to.not.have.property('rollcalls')
            })

            it('reports a signer with no broadcast export, naming the file, independent of wallet state', async function () {
                const OPERATOR_SIGNER = '/home/op/hub-signer/signer.js'
                const fs = makeFs({
                    lstatSync: fileLstat([OPERATOR_SIGNER]),
                    readFileSync: sinon.stub().returns('module.exports = {\n  async walletSign(p) { return "s" }\n};')
                })
                const vs = loadValidatorService(fs)
                const result = await vs.getRollcallStatus(null, 'testnet', {
                    getActiveSignerFile: () => OPERATOR_SIGNER
                })
                // With no walletInfo, doge/absences stay null but broadcast is still computed:
                // the check has nothing to do with whether wallets exist.
                expect(result.doge).to.be.null
                expect(result.absences).to.be.null
                expect(result.broadcast).to.deep.equal({ file: OPERATOR_SIGNER, exportsBroadcast: false })
            })
        })
    })
})
