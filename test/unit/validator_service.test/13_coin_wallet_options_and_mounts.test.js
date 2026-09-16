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

    describe('coin wallets', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_STAKE_WIF
            delete process.env.XCHAIN_NODE_DOGE_WIF
            delete process.env.HUB_NETWORK
            delete process.env.DOGE_ENCODER_URL
            delete process.env.XCHAIN_NODE_HUB_SIGNER_DIR
        })

        // Both federation defaults must sit in the PAST. A future epoch numbers
        // every round negative and OracleRound drops peer submissions for
        // round < 0, which is the failure testnet paid a federation-wide flag
        // day for on 2026-08-28; mainnet is ruled past up front to avoid it.
        // They must also differ, so a round number never lines up across the
        // two federations.
        it('both federation default epochs are in the past, and differ', async function () {
            const vs = loadValidatorService(makeFs())
            const mainnet = await vs.initValidator({ p2pPort: '10001' })
            const testnet = await vs.initValidator({ p2pPort: '10002', force: true })
            expect(mainnet.ORACLE_EPOCH_START).to.be.a('number').and.to.be.lessThan(Date.now())
            expect(testnet.ORACLE_EPOCH_START).to.be.a('number').and.to.be.lessThan(Date.now())
            expect(mainnet.ORACLE_EPOCH_START).to.not.equal(testnet.ORACLE_EPOCH_START)
        })

        it('skips wallets on a non-standard port and says so, without failing init', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            const logged = []
            const stub = sinon.stub(console, 'log').callsFake(m => logged.push(String(m)))
            try { await vs.initValidator({ p2pPort: '10099' }) } finally { stub.restore() }
            expect(writtenWallets(fs)).to.be.null
            expect(logged.some(l => /Wallets skipped: the network is unknown/.test(l))).to.be.true
        })

        it('refuses to import a key when the network is unknown', async function () {
            const vs = loadValidatorService(makeFs())
            process.env.XCHAIN_NODE_STAKE_WIF = 'cV' + 'x'.repeat(50)
            let err = null
            try { await vs.initValidator({ p2pPort: '10099', importStakeKey: true }) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/without knowing the network/)
        })

        it('--no-wallets skips wallet generation entirely', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet', wallets: false })
            expect(writtenWallets(fs)).to.be.null
            const caps = JSON.parse(fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_CAPS_FILE).args[1])
            expect(caps.oracle_publish.doge_address).to.equal('REPLACE_WITH_DOGE_ADDRESS')
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

        it('imports operator-supplied WIFs from the environment and derives their addresses', async function () {
            // Generate two known keys through the SDK, then hand them to init the
            // way a vanity-address operator would: as WIFs, never as argv.
            const { XChainSDK } = require('@dankest-llc/xchain-sdk')
            const btc  = new XChainSDK({ network: 'bitcoin-testnet' })
            const doge = new XChainSDK({ network: 'dogecoin-testnet' })
            const stakeKey = btc.wallet.generateKeyPair()
            const dogeKey  = doge.wallet.generateKeyPair()
            process.env.XCHAIN_NODE_STAKE_WIF = stakeKey.wif
            process.env.XCHAIN_NODE_DOGE_WIF  = dogeKey.wif

            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            const w = writtenWallets(fs)
            expect(w.STAKE_ADDRESS).to.equal(btc.wallet.deriveAddress(stakeKey.publicKey))
            expect(w.STAKE_WIF_SECRET).to.equal(stakeKey.wif)
            expect(w.DOGE_ADDRESS).to.equal(doge.wallet.deriveAddress(dogeKey.publicKey))
            expect(w.DOGE_WIF_SECRET).to.equal(dogeKey.wif)
        })

        it('rejects a WIF from the wrong network', async function () {
            const { XChainSDK } = require('@dankest-llc/xchain-sdk')
            const mainnetKey = new XChainSDK({ network: 'bitcoin-mainnet' }).wallet.generateKeyPair()
            process.env.XCHAIN_NODE_STAKE_WIF = mainnetKey.wif
            const vs = loadValidatorService(makeFs())
            let err = null
            try { await vs.initValidator({ network: 'testnet' }) } catch (e) { err = e }
            expect(err).to.exist
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

        it('keeps existing wallets across --force (a funded address must not be abandoned silently)', async function () {
            const existing = [
                'NETWORK=testnet', 'STAKE_ADDRESS=mExistingStake', 'STAKE_PUBKEY_HEX=02aa', 'STAKE_WIF_SECRET=cExisting',
                'DOGE_ADDRESS=nExistingDoge', 'DOGE_PUBKEY_HEX=02bb', 'DOGE_WIF_SECRET=cExistingDoge', ''
            ].join('\n')
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p === FAKE_SETTINGS_FILE || p === FAKE_KEY_FILE),
                lstatSync:  fileLstat([FAKE_WALLETS_FILE]),
                readFileSync: sinon.stub().callsFake(p => {
                    if (p === FAKE_WALLETS_FILE) return existing
                    if (p === FAKE_SETTINGS_FILE) return JSON.stringify(makeSettings())
                    return '{}'
                })
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator({ force: true, p2pPort: '10002' })
            expect(writtenWallets(fs)).to.be.null
            // The fresh capabilities file (force rewrites it) still names the kept DOGE wallet.
            const caps = JSON.parse(fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_CAPS_FILE).args[1])
            expect(caps.oracle_publish.doge_address).to.equal('nExistingDoge')
        })

        it('--force-wallets replaces them', async function () {
            const existing = 'NETWORK=testnet\nSTAKE_ADDRESS=mExistingStake\nDOGE_ADDRESS=nExistingDoge\n'
            const fs = makeFs({
                lstatSync:    fileLstat([FAKE_WALLETS_FILE]),
                readFileSync: sinon.stub().callsFake(p => p === FAKE_WALLETS_FILE ? existing : '{}')
            })
            const vs = loadValidatorService(fs)
            await vs.initValidator({ p2pPort: '10002', forceWallets: true })
            const w = writtenWallets(fs)
            expect(w).to.exist
            expect(w.STAKE_ADDRESS).to.not.equal('mExistingStake')
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

        // Docker mounts the parent bind first, then the SDK on top of
        // signer/node_modules. A missing mountpoint under a read-only mount is
        // not a degraded signer, it aborts container creation, so init has to
        // leave the empty directory behind.
        it('creates the node_modules mountpoint the SDK mount lands on', async function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            await vs.initValidator({ network: 'testnet' })
            expect(fs.mkdirSync.calledWith(path.join(FAKE_SIGNER_DIR, 'node_modules'), { recursive: true })).to.be.true
        })

        it('creates that mountpoint at mount time too, for a config written before it existed', function () {
            const fs = makeFs({
                existsSync: sinon.stub().callsFake(p => p !== path.join(FAKE_SIGNER_DIR, 'node_modules')),
                lstatSync:  fileLstat([FAKE_SIGNER_FILE, FAKE_SIGNER_ENV])
            })
            const vs = loadValidatorService(fs)
            expect(vs.getSignerMountDir()).to.equal(FAKE_SIGNER_DIR)
            expect(fs.mkdirSync.calledWith(path.join(FAKE_SIGNER_DIR, 'node_modules'), { recursive: true })).to.be.true
        })

        it('does not claim a signer mount when the signer files are absent', function () {
            const fs = makeFs()
            const vs = loadValidatorService(fs)
            expect(vs.getSignerMountDir()).to.be.null
            expect(fs.mkdirSync.called).to.be.false
        })

        it('publicWalletInfo never carries a WIF', function () {
            const vs = loadValidatorService(makeFs())
            const info = vs.publicWalletInfo({
                NETWORK: 'testnet', STAKE_ADDRESS: 'mA', STAKE_PUBKEY_HEX: '02', STAKE_WIF_SECRET: 'cSECRET',
                DOGE_ADDRESS: 'nB', DOGE_PUBKEY_HEX: '03', DOGE_WIF_SECRET: 'cSECRET2'
            })
            expect(JSON.stringify(info)).to.not.include('SECRET')
            expect(info).to.deep.equal({ network: 'testnet', stakeAddress: 'mA', stakePubkeyHex: '02', dogeAddress: 'nB', dogePubkeyHex: '03' })
        })
    })
})
