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

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const path = require('path')
const vm = require('vm')
const { configStub } = require('../helpers/config_stub')
const { stakeValidator } = require('../../src/services/validator_stake_service')

const FAKE_CONFIG_DIR = '/tmp/test-xchain-config'
const FAKE_VALIDATOR_DIR = path.join(FAKE_CONFIG_DIR, 'validator')
const FAKE_SIGNER_DIR = path.join(FAKE_VALIDATOR_DIR, 'signer')
const FAKE_SIGNER_FILE = path.join(FAKE_SIGNER_DIR, 'signer.js')
const FAKE_HUB_SIDECAR = path.join(FAKE_CONFIG_DIR, 'hub.local')
const PHASE1 = 'f'.repeat(64)
const PUBKEY = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'

function makeHubApiKeyStub() {
    return sinon.stub().resolves({ path: FAKE_HUB_SIDECAR, generated: true })
}

function makeHubApiKeyReadStub() {
    return sinon.stub().resolves({ path: FAKE_HUB_SIDECAR, present: false })
}

function loadValidatorService(fsStub) {
    return proxyquire('../../src/services/validator_service', {
        'fs': fsStub,
        './config_service': {
            ensureHubApiKey: makeHubApiKeyStub(),
            readHubApiKey: makeHubApiKeyReadStub()
        },
        '../config': configStub({ configDir: FAKE_CONFIG_DIR })
    })
}

function makeFs() {
    return {
        existsSync: sinon.stub().returns(false),
        readFileSync: sinon.stub().returns('{}'),
        writeFileSync: sinon.stub(),
        mkdirSync: sinon.stub(),
        chmodSync: sinon.stub(),
        lstatSync: sinon.stub().throws(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        renameSync: sinon.stub(),
        readdirSync: sinon.stub().returns(['capabilities.json'])
    }
}

function loadEmittedSigner(source, encoder, encoderMethod) {
    const mod = { exports: {} }
    vm.runInNewContext(source, {
        require: (id) => {
            if (id === 'path') return path
            if (id === 'dotenv') return { config: () => ({}) }
            if (id === '@dankest-llc/xchain-sdk') return { XChainSDK: function () {
                this[encoderMethod] = () => encoder
                this.wallet = {
                    signPsbt: () => ({ txHex: 'hex-1', txid: PHASE1 }),
                    signRevealPsbt: () => ({ txHex: 'hex-2', txid: 'e'.repeat(64) })
                }
            } }
            throw new Error('unexpected require in the emitted signer: ' + id)
        },
        module: mod,
        exports: mod.exports,
        __dirname: FAKE_SIGNER_DIR,
        console,
        process: { env: {
            DOGE_NETWORK: 'dogecoin-testnet',
            DOGE_WIF: 'test-wif',
            DOGE_ADDRESS: 'test-address',
            DOGE_ENCODER_URL: 'http://encoder.invalid'
        } },
        Number, String, Error, Promise, Object
    }, { filename: 'signer.js' })
    return mod.exports
}

async function emitSigner() {
    const fs = makeFs()
    await loadValidatorService(fs).initValidator({ network: 'testnet' })
    return fs.writeFileSync.getCalls().find(c => c.args[0] === FAKE_SIGNER_FILE).args[1]
}

function stubEncoder() {
    return {
        createTx: async () => ({ psbt: 'psbt-1', encoding: 'P2SH' }),
        broadcastTx: async () => ({ txid: PHASE1 }),
        spendP2sh: async () => ({ psbt: 'psbt-2' })
    }
}

function makeExplorer(chain) {
    return {
        getAddress: sinon.stub().resolves({ balances: { confirmed: chain.coin, pending: '0' } }),
        getToken: sinon.stub().resolves({ mints: { max: 10000, address_max: 50000 } }),
        getValidators: sinon.stub().resolves({ data: [] }),
        // No delegation holds the key; without an answer the stake command refuses to send.
        getDelegations: sinon.stub().resolves({ total: 0, data: [] }),
        // The tip and an empty sleep list, so the stake address reads as awake rather than unknown.
        getStatus: sinon.stub().resolves({ last_block: { BTC: 200000, TBTC: 200000, RBTC: 200000 } }),
        getSleeps: sinon.stub().resolves({ total: 0, data: [] })
    }
}

function makeSdk(chain = {}) {
    const calls = { mint: [], stake: [] }
    const prevTxidRef = { value: null }
    const sdk = {
        explorer: makeExplorer(chain),
        getBalances: async () => ({ data: [{ tick: 'XCHAIN', amount: String(chain.xchain) }] }),
        session: () => ({
            address: ADDRESS,
            submit: async (actionData, enc, opts) => {
                const rec = { params: actionData.params, enc, opts }
                if (actionData.action === 'MINT') calls.mint.push(rec)
                if (actionData.action === 'STAKE') calls.stake.push(rec)
                const txid = actionData.action === 'STAKE' ? 'staketx' : 'mint' + calls.mint.length
                prevTxidRef.value = txid
                return { txid, spentInputs: (enc.utxos || []).map(u => ({ txid: u.txid, vout: u.vout })) }
            }
        }),
        _requireEncoder: () => ({
            getUTXOs: async () => ({ utxos: [{
                txid: prevTxidRef.value || 'seed',
                fullTxid: prevTxidRef.value || 'seed',
                vout: 1,
                value: '150000',
                confirmations: 0
            }] })
        })
    }
    return { sdk, calls }
}

function run(opts, chain) {
    const { sdk, calls } = makeSdk(chain)
    const deps = {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
        wallets: { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk: () => sdk,
        sdk: { XChainSDK: function () { throw new Error('makeSdk should be used') } },
        log: () => {}
    }
    return stakeValidator(opts, deps).then(result => ({ result, calls }))
}

describe('SDK encoder compatibility', function () {
    for (const encoderMethod of ['_requireEncoder', 'requireEncoder']) {
        it('broadcasts from the emitted signer with ' + encoderMethod, async function () {
            const signer = loadEmittedSigner(await emitSigner(), stubEncoder(), encoderMethod)
            const result = await signer.broadcast('payload')
            expect(result.phase1_txid).to.equal(PHASE1)
        })
    }

    it('chains stake actions with the underscore encoder method', async function () {
        const { calls } = await run(
            { broadcast: true, chainTimeoutMs: 50, balancePollMs: 5 },
            { xchain: 0, coin: '0.001' })
        expect(calls.mint[1].enc.utxos.map(u => u.txid)).to.deep.equal(['mint1'])
        expect(calls.stake[0].enc.utxos.map(u => u.txid)).to.deep.equal(['mint3'])
    })
})
