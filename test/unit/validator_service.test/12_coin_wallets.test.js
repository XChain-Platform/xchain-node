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
// ValidatorService loads the SDK lazily, but this suite exercises real wallet
// generation. Pay the SDK's module-load cost while Mocha loads the test file,
// outside the timed test body, so the 10-second verify timeout measures init.
require('@dankest-llc/xchain-sdk')
// Fake config dir (never touches the real filesystem)
const FAKE_CONFIG_DIR = '/tmp/test-xchain-config'
const FAKE_VALIDATOR_DIR = path.join(FAKE_CONFIG_DIR, 'validator')
const FAKE_SETTINGS_FILE  = path.join(FAKE_VALIDATOR_DIR, 'validator.json')
// The capability config lives in its OWN directory: that directory is what the
// hub container bind-mounts, and a single-FILE bind mount breaks `docker cp`
// against the container for every path. signing.key must stay outside it.
const FAKE_CAPS_DIR      = path.join(FAKE_VALIDATOR_DIR, 'hub-caps')
const FAKE_CAPS_FILE     = path.join(FAKE_CAPS_DIR, 'capabilities.json')
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


// The two coin wallets init writes: the BTC stake wallet (fees, mints, the
// STAKE itself) and the DOGE wallet the hub publishes price rounds and
// anchors from. Real key generation through the SDK, offline; only the
// filesystem is faked.
describe('ValidatorService', function () {

    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        it('generates a testnet stake wallet and a testnet DOGE wallet for port 10002', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ p2pPort: '10002' })
            expect(result.network).to.equal('testnet')
            const w = writtenWallets(fs)
            expect(w).to.exist
            expect(w.NETWORK).to.equal('testnet')
            expect(w.STAKE_ADDRESS).to.match(/^[mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/)   // BTC testnet P2PKH
            expect(w.DOGE_ADDRESS).to.match(/^n[a-km-zA-HJ-NP-Z1-9]{33}$/)          // DOGE testnet P2PKH
            expect(w.STAKE_WIF_SECRET).to.be.a('string').with.length.above(50)
            expect(w.DOGE_WIF_SECRET).to.be.a('string').with.length.above(50)
            expect(w.STAKE_PUBKEY_HEX).to.match(/^0[23][0-9a-f]{64}$/)
            expect(w.DOGE_PUBKEY_HEX).to.match(/^0[23][0-9a-f]{64}$/)
        })

        it('writes wallets.env and the signer .env with mode 0600, and the signer module beside it', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const byPath = p => fs.writeFileSync.getCalls().find(c => c.args[0] === p)
            expect(byPath(FAKE_WALLETS_FILE).args[2]).to.deep.equal({ mode: 0o600 })
            expect(byPath(FAKE_SIGNER_ENV).args[2]).to.deep.equal({ mode: 0o600 })
            expect(fs.chmodSync.calledWith(FAKE_WALLETS_FILE, 0o600)).to.be.true
            expect(fs.chmodSync.calledWith(FAKE_SIGNER_ENV, 0o600)).to.be.true
            const signer = byPath(FAKE_SIGNER_FILE)
            expect(signer).to.exist
            expect(signer.args[1]).to.include("require('@dankest-llc/xchain-sdk')")
            expect(signer.args[1]).to.include('async walletSign(psbtHex)')
            expect(signer.args[1]).to.include('async broadcast(payload)')
        })
    })
})

describe('ValidatorService', function () {

    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        it('points the signer at the DOGE wallet and the public testnet encoder', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const w = writtenWallets(fs)
            const env = fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_SIGNER_ENV).args[1]
            expect(env).to.include('DOGE_NETWORK=dogecoin-testnet')
            expect(env).to.include('DOGE_ADDRESS=' + w.DOGE_ADDRESS)
            expect(env).to.include('DOGE_WIF=' + w.DOGE_WIF_SECRET)
            expect(env).to.include('DOGE_ENCODER_URL=https://encoder.xchain.io/TDOGE')
            // The stake key is NOT in the mounted directory.
            expect(env).to.not.include(w.STAKE_WIF_SECRET)
        })

        it('fills oracle_publish in the fresh capabilities file from the DOGE wallet', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const w = writtenWallets(fs)
            const caps = JSON.parse(fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_CAPS_FILE).args[1])
            expect(caps.oracle_publish.doge_address).to.equal(w.DOGE_ADDRESS)
            expect(caps.oracle_publish.doge_wallet).to.equal('/XChainHub/operator-signer/.env')
        })

        it('--network names the federation and picks the matching port', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ network: 'testnet' })
            expect(result.P2P_PORT).to.equal(10002)
            expect(result.network).to.equal('testnet')
            expect(result.SEED_NODES).to.deep.equal(['01','02','03','04','05'].map(n => 'ws://validator' + n + '.xchain.io:10002'))
        })

    })
})

// Its own block, not a fifth case inside 'coin wallets': that describe was
// already at the readability limit for a single function, and regtest init is
// a separate federation shape rather than another wallet assertion.
describe('ValidatorService', function () {

    describe('regtest initialization', function () {

        it('records regtest on its local port without mainnet federation seeds', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const result = await vs.initValidator({ network: 'regtest', wallets: false })
            expect(result.network).to.equal('regtest')
            expect(result.P2P_PORT).to.equal(10003)
            expect(result.P2P_VALIDATOR_ADDR).to.equal('0.0.0.0:10003')
            expect(result.SEED_NODES).to.deep.equal([])
            const write = fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_SETTINGS_FILE)
            const recorded = JSON.parse(write.args[1])
            expect(recorded.network).to.equal('regtest')
            expect(recorded.P2P_PORT).to.equal(10003)
            expect(recorded.P2P_VALIDATOR_ADDR).to.equal('0.0.0.0:10003')
            expect(recorded.SEED_NODES).to.deep.equal([])
        })

        it('recognizes P2P port 10003 as regtest without federation seeds', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10003', wallets: false })
            expect(result.network).to.equal('regtest')
            expect(result.SEED_NODES).to.deep.equal([])
        })
    })
})

describe('ValidatorService', function () {

    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        it('rejects an unknown --network', async function () {
            const vs = loadValidatorService(makeFs())
            let err = null
            try { await vs.initValidator({ network: 'devnet' }) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/--network must be one of/)
        })

        it('defaults ORACLE_EPOCH_START to the testnet federation value', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10002' })
            expect(result.ORACLE_EPOCH_START).to.equal(1787875200000)
        })

        it('--oracle-epoch-start still overrides the federation default', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10002', oracleEpochStart: '1717200000000' })
            expect(result.ORACLE_EPOCH_START).to.equal(1717200000000)
        })

        it('defaults ORACLE_EPOCH_START to the mainnet federation value', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10001' })
            expect(result.network).to.equal('mainnet')
            expect(result.ORACLE_EPOCH_START).to.equal(1788220800000)
        })

        it('leaves ORACLE_EPOCH_START null when the network is unknown', async function () {
            const vs = loadValidatorService(makeFs())
            const result = await vs.initValidator({ p2pPort: '10009' })
            expect(result.network).to.be.null
            expect(result.ORACLE_EPOCH_START).to.be.null
        })
    })
})
