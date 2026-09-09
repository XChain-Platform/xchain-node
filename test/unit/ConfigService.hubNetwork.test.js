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
const { expect } = require('chai')
// noPreserveCache: the deploy-time hub warnings are said once per loaded module, so each
// case needs its own instance or the first one to warn silences the rest.
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const realFs     = require('fs')

const {
    HUB_MODULE_NAME, Coin, Network, XChainService
} = require('../../src/config/constants')
const state = require('../../src/state')

// A standalone install is the subject here, so the validator env is stubbed away: read
// from the real filesystem it would hand every case this machine's recorded network and
// its live signing key (the hazard ConfigService.test.js documents at the top).
const NO_VALIDATOR = {
    getValidatorSettings: () => null,
    getValidatorEnv:      () => ({}),
    // The hub config states which validator mode it resolved and from where, so a
    // stub that omits this is not a standalone machine, it is a broken module.
    validatorModeReport:  () => ({ mode: "standalone", dir: "/tmp/test-xchain-config/validator", missing: [] })
}

// The hub API-key sidecar is a real file on an operator box. Read, it would key the hub
// and skip the keyless declaration one case below asserts, so this describes a host that
// has never run `validator init`.
const FS_WITHOUT_SIDECAR = Object.assign({}, realFs, {
    existsSync: (p) => (String(p).endsWith('hub.local') ? false : realFs.existsSync(p))
})

function makeConfigService() {
    return proxyquire('../../src/services/ConfigService', {
        'fs': FS_WITHOUT_SIDECAR,
        './ValidatorService': NO_VALIDATOR
    })
}

// One registry row as MariaDbStore.getAllModuleContainers returns them.
function stack(module, coin, network) {
    return { module, coin, network, container_id: 'container-id-fixture' }
}

describe('ConfigService hub network and BTC indexer composition', function () {

    const HUB_ENV_KEYS = ['HUB_NETWORK', 'BTC_INDEXER_API_URL', 'HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED']
    let savedEnv, savedArgv, registry

    beforeEach(function () {
        savedEnv = {}
        for (const k of HUB_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
        savedArgv = process.argv
        registry = sinon.stub(state.db, 'getAllModuleContainers').resolves([])
        sinon.stub(console, 'warn')
    })

    afterEach(function () {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        process.argv = savedArgv
        sinon.restore()
    })

    function runningCommand(...args) {
        process.argv = ['/usr/bin/node', '/usr/local/bin/xchain-node', ...args]
    }

    async function hubConfig() {
        return await makeConfigService().getDefaultConfig(HUB_MODULE_NAME, null, null)
    }

    describe('HUB_NETWORK', function () {

        // The measured defect: a stock `install dogecoin testnet` left the local hub with
        // no HUB_NETWORK at all, so its ingest resolved network '' and refused every
        // on-chain PRICE batch.
        it('takes the network the running install names when no stack is registered yet', async function () {
            runningCommand('install', 'dogecoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['HUB_NETWORK']).to.equal('testnet')
        })

        it('prefers the registered stacks over the command tokens', async function () {
            registry.resolves([
                stack(XChainService.XCHAIN_INDEXER, Coin.DOGECOIN, Network.TESTNET),
                stack(XChainService.XCHAIN_DECODER, Coin.DOGECOIN, Network.TESTNET)
            ])
            runningCommand('install', 'litecoin', 'regtest')
            const cfg = await hubConfig()
            expect(cfg['HUB_NETWORK']).to.equal(Network.TESTNET)
        })

        // One hub serves every stack on the host. Guessing a network for a host that runs
        // two mis-gates the ingest rules this value exists to gate, so it stays unset.
        it('leaves HUB_NETWORK unset when the deployment spans two networks', async function () {
            registry.resolves([
                stack(XChainService.XCHAIN_INDEXER, Coin.DOGECOIN, Network.TESTNET),
                stack(XChainService.XCHAIN_INDEXER, Coin.BITCOIN, Network.REGTEST)
            ])
            runningCommand('install', 'dogecoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['HUB_NETWORK']).to.equal(undefined)
        })

        it('never overrides the operator host env', async function () {
            process.env.HUB_NETWORK = Network.MAINNET
            runningCommand('install', 'dogecoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['HUB_NETWORK']).to.equal(Network.MAINNET)
        })

        // The keyless declaration reads HUB_NETWORK, and a derived mainnet must not turn a
        // fresh mainnet install into a hub that refuses to boot for a missing key: that
        // decision stays the operator's, exactly as it was before the derivation.
        it('does not change the keyless declaration a mainnet install already got', async function () {
            runningCommand('install', 'bitcoin', 'mainnet')
            const cfg = await hubConfig()
            expect(cfg['HUB_NETWORK']).to.equal(Network.MAINNET)
            expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
        })
    })

    describe('BTC_INDEXER_API_URL', function () {

        const btcIndexerUrl = (network) =>
            'http://xchain-node-bitcoin-' + network + '-xchain-indexer:3004'

        it('composes the co-located BTC indexer for the hub network', async function () {
            registry.resolves([
                stack(XChainService.XCHAIN_INDEXER, Coin.BITCOIN, Network.TESTNET),
                stack(XChainService.XCHAIN_INDEXER, Coin.DOGECOIN, Network.TESTNET)
            ])
            runningCommand('install', 'dogecoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['BTC_INDEXER_API_URL']).to.equal(btcIndexerUrl(Network.TESTNET))
        })

        // preCheck deploys the shared hub BEFORE the coin stack exists, so a registry-only
        // read would miss the indexer this very command is about to create.
        it('composes the indexer the running install is about to create', async function () {
            runningCommand('install', 'bitcoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['BTC_INDEXER_API_URL']).to.equal(btcIndexerUrl(Network.TESTNET))
        })

        it('leaves it empty when this deployment runs no BTC indexer', async function () {
            registry.resolves([stack(XChainService.XCHAIN_INDEXER, Coin.DOGECOIN, Network.TESTNET)])
            runningCommand('install', 'dogecoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['BTC_INDEXER_API_URL']).to.equal('')
        })

        // A BTC indexer on another network answers for another chain, so composing it
        // would point the capability reads at the wrong ledger. The hub's own network is
        // declared here, so the case turns on the indexer's network and nothing else.
        it('ignores a BTC indexer installed on a different network', async function () {
            process.env.HUB_NETWORK = Network.TESTNET
            registry.resolves([stack(XChainService.XCHAIN_INDEXER, Coin.BITCOIN, Network.REGTEST)])
            runningCommand('install', 'bitcoin', 'regtest')
            const cfg = await hubConfig()
            expect(cfg['HUB_NETWORK']).to.equal(Network.TESTNET)
            expect(cfg['BTC_INDEXER_API_URL']).to.equal('')
        })

        it('never overrides the operator host env', async function () {
            process.env.BTC_INDEXER_API_URL = 'http://btc-indexer.fixture.invalid:3004'
            registry.resolves([stack(XChainService.XCHAIN_INDEXER, Coin.BITCOIN, Network.TESTNET)])
            runningCommand('install', 'dogecoin', 'testnet')
            const cfg = await hubConfig()
            expect(cfg['BTC_INDEXER_API_URL']).to.equal('http://btc-indexer.fixture.invalid:3004')
        })

        // The hub that cannot read a capability snapshot records every on-chain PRICE
        // batch invalid, silently, for the life of the deployment. Saying so at deploy
        // time is the only place an operator sees it before their mirror never fills.
        it('warns, naming the consequence, when nothing can be composed', async function () {
            registry.resolves([stack(XChainService.XCHAIN_INDEXER, Coin.DOGECOIN, Network.TESTNET)])
            runningCommand('install', 'dogecoin', 'testnet')
            await hubConfig()
            const warnings = console.warn.getCalls().map(c => String(c.args[0]))
            expect(warnings.some(w => w.includes('BTC_INDEXER_API_URL')
                && w.includes('insufficient signer stake'))).to.equal(true)
        })

        // One command composes the hub config many times (measured: 21 on one install),
        // and a warning printed twenty-one times is a warning nobody reads.
        it('says it once however often the config is composed', async function () {
            registry.resolves([stack(XChainService.XCHAIN_INDEXER, Coin.DOGECOIN, Network.TESTNET)])
            runningCommand('install', 'dogecoin', 'testnet')
            const cs = makeConfigService()
            for (let i = 0; i < 5; i++) await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
            const warnings = console.warn.getCalls()
                .map(c => String(c.args[0]))
                .filter(w => w.includes('this hub has no BTC indexer'))
            expect(warnings.length).to.equal(1)
        })
    })
})
