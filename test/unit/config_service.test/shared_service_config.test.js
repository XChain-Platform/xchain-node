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

function sharedServiceConfig1() {
    it('returns HUB_PORT as 10000', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['HUB_PORT']).to.equal(10000)
    })

    // the hub has no per-coin config file, so a host env override is
    // the only injection point for a second co-located install (e.g. verifying
    // `install master xchain-hub` boots without tearing down a standing shared
    // hub on the default 10000). Mirrors the EXPLORER_PORT_HTTP/HTTPS/PORT
    // override above HUB_PORT in ConfigService.js.
    it('honours a HUB_PORT host env override', async function () {
        const prev = process.env.HUB_PORT
        process.env.HUB_PORT = '10001'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
            expect(config['HUB_PORT']).to.equal('10001')
        } finally {
            if (prev === undefined) delete process.env.HUB_PORT
            else process.env.HUB_PORT = prev
        }
    })

    it('leaves HUB_PORT at the 10000 default when host env sets no override', async function () {
        const prev = process.env.HUB_PORT
        delete process.env.HUB_PORT
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
            expect(config['HUB_PORT']).to.equal(10000)
        } finally {
            if (prev === undefined) delete process.env.HUB_PORT
            else process.env.HUB_PORT = prev
        }
    })

    it('returns EXPLORER_PORT as 18080', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config['EXPLORER_PORT']).to.equal(18080)
        expect(config['EXPLORER_PORT_HTTP']).to.equal(18080)
    })
}

function sharedServiceConfig2() {
    // The explorer's quote/pre-flight proxies resolve their
    // upstream from these, and their absence fails SOFT: the routes
    // answer INDEXER_NOT_CONFIGURED and the wallet quietly drops to
    // its client-side pre-flight tier rather than erroring. Nothing
    // in the running system complains, so pin the emission here.
    it('emits INDEXER_API_URL_<COIN>_<NETWORK> for every coin and network', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config['INDEXER_API_URL_BTC_REGTEST'])
            .to.equal('http://xchain-node-bitcoin-regtest-xchain-indexer:3004')
        expect(config['INDEXER_API_URL_BTC_MAINNET'])
            .to.equal('http://xchain-node-bitcoin-mainnet-xchain-indexer:3004')
        expect(config['INDEXER_API_URL_LTC_REGTEST'])
            .to.equal('http://xchain-node-litecoin-regtest-xchain-indexer:3004')
        expect(config['INDEXER_API_URL_DOGE_TESTNET'])
            .to.equal('http://xchain-node-dogecoin-testnet-xchain-indexer:3004')
    })

    // The container-local default must never win over an operator's
    // value: an explorer whose indexers live on other boxes sets this
    // by hand, and overriding it would point a working
    // production explorer at a hostname that does not resolve.
    it('yields INDEXER_API_URL_<COIN>_<NETWORK> to the host env', async function () {
        const prev = process.env.INDEXER_API_URL_BTC_MAINNET
        process.env.INDEXER_API_URL_BTC_MAINNET = 'http://203.0.113.5:3004'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
            expect(config['INDEXER_API_URL_BTC_MAINNET']).to.equal('http://203.0.113.5:3004')
            // Unrelated coins keep the container-local default.
            expect(config['INDEXER_API_URL_LTC_MAINNET'])
                .to.equal('http://xchain-node-litecoin-mainnet-xchain-indexer:3004')
        } finally {
            if (prev === undefined) delete process.env.INDEXER_API_URL_BTC_MAINNET
            else process.env.INDEXER_API_URL_BTC_MAINNET = prev
        }
    })
}

function sharedServiceConfig3() {
    // Both serving limits default to values tuned for a PUBLIC explorer:
    // 500 requests/min/IP, and a 6-hour tip-age gate that delists a coin.
    // A private venue needs both loosened (a regtest chain only advances
    // when someone mines, so an idle one goes "stale" while lag stays 0),
    // and the explorer is a shared service with no per-venue config file,
    // so host env is the only injection point it has.
    it('passes the explorer serving limits through from the host env', async function () {
        const prev = {
            rpm:  process.env.EXPLORER_RATE_LIMIT_RPM,
            fq:   process.env.EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM,
            age:  process.env.EXPLORER_TIP_MAX_AGE_S,
            coin: process.env.EXPLORER_TIP_MAX_AGE_S_RBTC
        }
        process.env.EXPLORER_RATE_LIMIT_RPM     = '5000'
        process.env.EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM = '2000'
        process.env.EXPLORER_TIP_MAX_AGE_S      = '0'
        process.env.EXPLORER_TIP_MAX_AGE_S_RBTC = '0'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
            expect(config['EXPLORER_RATE_LIMIT_RPM']).to.equal('5000')
            expect(config['EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM']).to.equal('2000')
            expect(config['EXPLORER_TIP_MAX_AGE_S']).to.equal('0')
            // Deliberately NOT carried: the explorer honours the per-coin
            // form itself, and passing it through here would need a
            // computed env read, which the platform's coverage gate cannot
            // scan. The global knob covers the case this exists for.
            expect(config).to.not.have.property('EXPLORER_TIP_MAX_AGE_S_RBTC')
        } finally {
            for (const [k, v] of [
                ['EXPLORER_RATE_LIMIT_RPM', prev.rpm],
                ['EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM', prev.fq],
                ['EXPLORER_TIP_MAX_AGE_S', prev.age],
                ['EXPLORER_TIP_MAX_AGE_S_RBTC', prev.coin]
            ]) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    })

    // Unset stays unset: the explorer's own defaults must keep applying to
    // a deployment that never sets these, or every install would start
    // emitting a limit nobody chose.
    it('emits no serving-limit keys when the host env carries none', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config).to.not.have.property('EXPLORER_RATE_LIMIT_RPM')
        expect(config).to.not.have.property('EXPLORER_TIP_MAX_AGE_S')
    })
}

function sharedServiceConfig4() {
    // The five per-route knobs (checkpoint-list/verify, action-proof,
    // validator-set-proof, vm-query) were missing from this passthrough
    // (row 14, rate-limits-that-fit-the-wallet C10): a node-managed
    // explorer (the regtest venue) could raise only the app-wide and
    // fee-quote caps before this change.
    it('passes the five per-route explorer rate limits through from the host env', async function () {
        const prev = {
            list:    process.env.EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM,
            verify:  process.env.EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM,
            action:  process.env.EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM,
            valset:  process.env.EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM,
            vmquery: process.env.EXPLORER_VM_QUERY_RATE_LIMIT_RPM
        }
        process.env.EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM     = '150'
        process.env.EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM   = '95'
        process.env.EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM        = '95'
        process.env.EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM = '35'
        process.env.EXPLORER_VM_QUERY_RATE_LIMIT_RPM            = '25'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
            expect(config['EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM']).to.equal('150')
            expect(config['EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM']).to.equal('95')
            expect(config['EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM']).to.equal('95')
            expect(config['EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM']).to.equal('35')
            expect(config['EXPLORER_VM_QUERY_RATE_LIMIT_RPM']).to.equal('25')
        } finally {
            for (const [k, v] of [
                ['EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM', prev.list],
                ['EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM', prev.verify],
                ['EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM', prev.action],
                ['EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM', prev.valset],
                ['EXPLORER_VM_QUERY_RATE_LIMIT_RPM', prev.vmquery]
            ]) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    })

    it('emits no per-route explorer rate-limit keys when the host env carries none', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config).to.not.have.property('EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM')
        expect(config).to.not.have.property('EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM')
        expect(config).to.not.have.property('EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM')
        expect(config).to.not.have.property('EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM')
        expect(config).to.not.have.property('EXPLORER_VM_QUERY_RATE_LIMIT_RPM')
    })
}

function sharedServiceConfig5() {
    // The batch routes (POST /balances, POST /coinpay_obligations) share
    // one limiter knob, passed through the same way as the other eight
    // (row 55, rate-limits-that-fit-the-wallet D69).
    it('passes the batch explorer rate limit through from the host env', async function () {
        const prev = process.env.EXPLORER_BATCH_RATE_LIMIT_RPM
        process.env.EXPLORER_BATCH_RATE_LIMIT_RPM = '144'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
            expect(config['EXPLORER_BATCH_RATE_LIMIT_RPM']).to.equal('144')
        } finally {
            if (prev === undefined) delete process.env.EXPLORER_BATCH_RATE_LIMIT_RPM
            else process.env.EXPLORER_BATCH_RATE_LIMIT_RPM = prev
        }
    })

    it('emits no EXPLORER_BATCH_RATE_LIMIT_RPM when the host env carries none', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config).to.not.have.property('EXPLORER_BATCH_RATE_LIMIT_RPM')
    })

    it('returns EXPLORER_API_PORT_HTTP as 8080', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config['EXPLORER_API_PORT_HTTP']).to.equal(8080)
    })

    it('returns EXPLORER_PORT_HTTPS as 18081', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        expect(config['EXPLORER_PORT_HTTPS']).to.equal(18081)
    })

    it('returns SYNC_MODE as server', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
        expect(config['SYNC_MODE']).to.equal('server')
    })

    it('passes HUB_API_KEY through from host env to shared-service configs (keyed sensitive-read tier)', async function () {
        const prev = process.env.HUB_API_KEY
        process.env.HUB_API_KEY = 'hub-secret-456'
        try {
            const cs = makeServiceWithConfig('')
            const syncCfg = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
            expect(syncCfg['HUB_API_KEY']).to.equal('hub-secret-456')
            const explorerCfg = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
            expect(explorerCfg['HUB_API_KEY']).to.equal('hub-secret-456')
        } finally {
            if (prev === undefined) delete process.env.HUB_API_KEY
            else process.env.HUB_API_KEY = prev
        }
    })
}

function sharedServiceConfig6() {
    it('omits HUB_API_KEY from shared-service configs when unset in host env', async function () {
        const prev = process.env.HUB_API_KEY
        delete process.env.HUB_API_KEY
        try {
            const cs = makeServiceWithConfig('')
            const syncCfg = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
            expect(syncCfg['HUB_API_KEY']).to.equal(undefined)
        } finally {
            if (prev === undefined) delete process.env.HUB_API_KEY
            else process.env.HUB_API_KEY = prev
        }
    })

    it('returns SYNC_API_PORT as 3006', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
        expect(config['SYNC_API_PORT']).to.equal(3006)
    })

    it('does not include coin-specific keys like NODE_PORT', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['NODE_PORT']).to.be.undefined
        expect(config['DECODER_DB_NAME']).to.be.undefined
    })
}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', sharedServiceConfig1)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', sharedServiceConfig2)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', sharedServiceConfig3)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', sharedServiceConfig4)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', sharedServiceConfig5)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', sharedServiceConfig6)
    })
})
