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


const {
    sinon, configStub, expect, proxyquire, path,
    NODE_PREFIX, SEP, DB_SEP, NODE_MODULE_NAME, DB_MODULE_NAME,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, Coin, Network,
    XChainService, CoinTickerSymbol, REGTEST_MODULES, moduleDir, tmpDir,
    cryptoNodesDir, dataDir, configDir, NO_VALIDATOR, makeConfigService,
    streamFromString, makeServiceWithConfig, makeMemoryConfigService, CONTAINER_ID, coinSidecar,
    coinMain, hubSidecar
} = require('./helpers.test')

// A validator-mode hub REFUSES TO BOOT with no HUB_API_KEY, and `validator init`
// now leaves one in the shared hub sidecar. These pin the consumption half: the
// generated credential has to reach the hub container, and every service on the
// host that authenticates to that hub has to present the SAME value.
function hubApiKeySidecar() {
    // Not a credential: a fixture value chosen to be unmistakable in a diff.
    const SIDECAR_FIXTURE = 'sidecar-fixture-value-not-a-credential'
    let saved

    beforeEach(function () {
        saved = {}
        for (const k of ['HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED', 'HUB_NETWORK']) {
            saved[k] = process.env[k]
            delete process.env[k]
        }
    })
    afterEach(function () {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    it('deploys the hub KEYED off the sidecar instead of declaring it keyless', async function () {
        const { cs } = makeMemoryConfigService({ [hubSidecar]: 'HUB_API_KEY=' + SIDECAR_FIXTURE + '\n' })
        const cfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
        expect(cfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
    })

    // Otherwise the fix just moves the dead node downstream: a keyed hub 401s
    // the co-located indexer's chain-tip writes.
    it('gives the co-located indexer the same key the hub runs with', async function () {
        const { cs } = makeMemoryConfigService({ [hubSidecar]: 'HUB_API_KEY=' + SIDECAR_FIXTURE + '\n' })
        const hubCfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
        const idxCfg = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'testnet')
        const syncCfg = await cs.getDefaultConfig(SYNC_MODULE_NAME, '', '')
        // Named explicitly, not just compared: two services that both resolved
        // NOTHING are equal too, and that is the outage this pins against.
        expect(hubCfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
        expect(idxCfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
        expect(syncCfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
    })

    it('yields to a host-env key (an operator override is never overwritten)', async function () {
        process.env.HUB_API_KEY = 'host-env-fixture-value'
        const { cs } = makeMemoryConfigService({ [hubSidecar]: 'HUB_API_KEY=' + SIDECAR_FIXTURE + '\n' })
        const cfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
        expect(cfg['HUB_API_KEY']).to.equal('host-env-fixture-value')
    })

    // A node that never ran `validator init` must deploy exactly as before:
    // this path reads, it never mints.
    it('leaves a node with no generated key on its prior keyless declaration', async function () {
        const { cs, files } = makeMemoryConfigService()
        const cfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
        expect(cfg['HUB_API_KEY']).to.equal(undefined)
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
        expect(files[hubSidecar] || '').to.not.include('HUB_API_KEY=')
    })

}

function feeDestinationInjection() {
    const FEE_ENV = 'XCHAIN_FEE_DESTINATION_BTC_REGTEST'
    let savedPerCoin, savedGeneric
    beforeEach(function () {
        savedPerCoin = process.env[FEE_ENV]
        savedGeneric = process.env.FEE_DESTINATION
        delete process.env[FEE_ENV]
        delete process.env.FEE_DESTINATION
    })
    afterEach(function () {
        if (savedPerCoin === undefined) delete process.env[FEE_ENV]; else process.env[FEE_ENV] = savedPerCoin
        if (savedGeneric === undefined) delete process.env.FEE_DESTINATION; else process.env.FEE_DESTINATION = savedGeneric
    })

    it('injects FEE_DESTINATION (decoder) + per-coin var (indexer) from the host env', async function () {
        process.env[FEE_ENV] = 'mFeeRegtestAddr111'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
        expect(config['FEE_DESTINATION']).to.equal('mFeeRegtestAddr111')
        expect(config[FEE_ENV]).to.equal('mFeeRegtestAddr111')
    })

    it('falls back to a generic FEE_DESTINATION host env var', async function () {
        process.env.FEE_DESTINATION = 'mGenericFeeAddr222'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config[FEE_ENV]).to.equal('mGenericFeeAddr222')
    })

    it('defaults to the vendored coin-registry pin when no host env is set', async function () {
        const { getCoinConfigByFullName } = require('../../../src/coins')
        const pinned = getCoinConfigByFullName('bitcoin', 'regtest').addresses.FEE_DESTINATION
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
        expect(config['FEE_DESTINATION']).to.equal(pinned)
        expect(config[FEE_ENV]).to.equal(pinned)
    })

    it('ignores host env overrides on mainnet and injects the registry pin', async function () {
        const MAINNET_ENV = 'XCHAIN_FEE_DESTINATION_BTC_MAINNET'
        const savedMainnet = process.env[MAINNET_ENV]
        process.env[MAINNET_ENV] = 'mEvilOverrideAddr333'
        process.env.FEE_DESTINATION = 'mEvilGenericAddr444'
        try {
            const { getCoinConfigByFullName } = require('../../../src/coins')
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            // resolveFeeDestination ignores the per-coin override on mainnet; the
            // generic var must be ignored there too (fee acceptance is consensus).
            const pinned = '1FeesxM9LTEjBYVTkynK6jfDBgvksuh2WL'
            expect(getCoinConfigByFullName('bitcoin', 'mainnet').addresses.FEE_DESTINATION).to.equal(pinned)
            expect(config['FEE_DESTINATION']).to.equal(pinned)
            expect(config[MAINNET_ENV]).to.equal(pinned)
        } finally {
            if (savedMainnet === undefined) delete process.env[MAINNET_ENV]; else process.env[MAINNET_ENV] = savedMainnet
        }
    })

}

function genesisBootstrapPassthrough() {
    const GENESIS_VARS = [
        'XCHAIN_GENESIS_BLOCK', 'XCHAIN_GENESIS_LEDGER_HASH', 'XCHAIN_GENESIS_DUMP_HASH',
        'GENESIS_LEDGER_PATH', 'GENESIS_DUMP_PATH',
        'GENESIS_BLOCK_TIMEOUT_MS', 'GENESIS_DUMP_TIMEOUT_MS',
        'GENESIS_AIRDROP_PATHS', 'GENESIS_AIRDROP_HASHES', 'GENESIS_AIRDROP_AMOUNTS',
        'GENESIS_AIRDROP_SNAPSHOT_BLOCK', 'GENESIS_AIRDROP_SET_HASH'
    ]
    let saved
    beforeEach(function () {
        saved = {}
        for (const v of GENESIS_VARS) { saved[v] = process.env[v]; delete process.env[v] }
    })
    afterEach(function () {
        for (const v of GENESIS_VARS) {
            if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
        }
    })

    it('injects the genesis env vars into the indexer config from the host env', async function () {
        process.env.XCHAIN_GENESIS_BLOCK       = '105'
        process.env.XCHAIN_GENESIS_LEDGER_HASH = 'deadbeef'
        process.env.XCHAIN_GENESIS_DUMP_HASH   = 'cafef00d'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['XCHAIN_GENESIS_BLOCK']).to.equal('105')
        expect(config['XCHAIN_GENESIS_LEDGER_HASH']).to.equal('deadbeef')
        expect(config['XCHAIN_GENESIS_DUMP_HASH']).to.equal('cafef00d')
    })

    it('passes the airdrop set through to the indexer (regtest dry-run seam)', async function () {
        process.env.GENESIS_AIRDROP_PATHS    = '/XChainIndexer/data/genesis/xcp.csv'
        process.env.GENESIS_AIRDROP_HASHES   = 'aa'
        process.env.GENESIS_AIRDROP_AMOUNTS  = '30000000.00000000'
        process.env.GENESIS_AIRDROP_SET_HASH = 'd'.repeat(64)
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['GENESIS_AIRDROP_PATHS']).to.equal('/XChainIndexer/data/genesis/xcp.csv')
        expect(config['GENESIS_AIRDROP_HASHES']).to.equal('aa')
        expect(config['GENESIS_AIRDROP_AMOUNTS']).to.equal('30000000.00000000')
        expect(config['GENESIS_AIRDROP_SET_HASH']).to.equal('d'.repeat(64))
    })

    it('does NOT inject genesis vars into a non-indexer module (decoder)', async function () {
        process.env.XCHAIN_GENESIS_BLOCK = '105'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
        expect(config).to.not.have.property('XCHAIN_GENESIS_BLOCK')
    })

    it('omits genesis vars entirely when unset (genesis stays disabled)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        for (const v of GENESIS_VARS) expect(config).to.not.have.property(v)
    })

}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('HUB_API_KEY from the shared hub sidecar', hubApiKeySidecar)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('native-coin fee destination injection', feeDestinationInjection)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('genesis-ledger bootstrap passthrough', genesisBootstrapPassthrough)
        })
    })
})
