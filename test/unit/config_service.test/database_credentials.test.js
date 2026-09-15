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

function databaseCredentials1() {
    it('does NOT auto-generate DB passwords where rotation cannot apply them (native/no-container -> static default)', async function () {
        // The 2026-06-26 indexer outage: a generated sidecar password the native-DB
        // rotation could never apply, desyncing config from the live account.
        const { cs, files } = makeMemoryConfigService()
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_PASS']).to.equal('xchain' + SEP + 'password')
        expect(config['INDEXER_DB_PASS']).to.equal('xchain' + SEP + 'password')
        expect(files[coinSidecar] || '').to.not.include('DECODER_DB_PASS=')
        expect(files[coinSidecar] || '').to.not.include('INDEXER_DB_PASS=')
    })

    it('generates per-install DB passwords when a DB container exists (rotation can apply them) and persists them', async function () {
        const { cs, files } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
        expect(config['INDEXER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
        expect(config['DECODER_DB_PASS']).to.not.equal('xchain' + SEP + 'password')
        expect(files[coinSidecar]).to.include('DECODER_DB_PASS=')
        expect(files[coinSidecar]).to.include('INDEXER_DB_PASS=')
    })

    it('generates per-install DB passwords under EXTERNAL_DB (native-path rotation)', async function () {
        const { cs } = makeMemoryConfigService({}, { externalDb: true })
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
        expect(config['DECODER_DB_PASS']).to.not.equal('xchain' + SEP + 'password')
    })

    it('reuses the persisted DB password on subsequent calls (stable across installs/updates)', async function () {
        const { cs } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
        const first  = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const second = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(second['DECODER_DB_PASS']).to.equal(first['DECODER_DB_PASS'])
        expect(second['INDEXER_DB_PASS']).to.equal(first['INDEXER_DB_PASS'])
    })

    it('an operator override in the main config file wins and is not regenerated', async function () {
        const { cs } = makeMemoryConfigService({ [coinMain]: 'DECODER_DB_PASS=operatorsecret\n' }, { dbContainerId: CONTAINER_ID })
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_PASS']).to.equal('operatorsecret')
    })

    it('generates the MISSING RPC credential when only one of NODE_USER/NODE_PASSWORD is present (#2404: no both-or-nothing fallback to "rpc")', async function () {
        // The old both-absent (&&) guard let a partial sidecar generate nothing, so
        // the missing half silently resolved to the static "rpc" default.
        const { cs } = makeMemoryConfigService({ [coinSidecar]: 'NODE_PASSWORD=operatorpass\n' })
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NODE_PASSWORD']).to.equal('operatorpass')        // present half preserved
        expect(config['NODE_USER']).to.be.a('string').with.length.greaterThan(0)
        expect(config['NODE_USER']).to.not.equal('rpc')                 // missing half generated, not the static default
    })
}

function databaseCredentials2() {
    it('recovers RPC credentials glued onto a preceding setting with no separating newline (#2405)', async function () {
        // Older appenders wrote NODE_USER= onto the last main-file line with no
        // leading newline (e.g. `DUST_AMOUNT=546NODE_USER=<hex>`), corrupting the
        // value and hiding the credential from the migration.
        const gluedUser = 'a'.repeat(24)
        const gluedPass = 'b'.repeat(48)
        const { cs, files } = makeMemoryConfigService({ [coinMain]: 'DUST_AMOUNT=546NODE_USER=' + gluedUser + '\nNODE_PASSWORD=' + gluedPass + '\n' })
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(String(config['DUST_AMOUNT'])).to.equal('546')           // value no longer corrupted by the glued credential
        expect(config['NODE_USER']).to.equal(gluedUser)                 // credential recovered, not regenerated
        expect(config['NODE_PASSWORD']).to.equal(gluedPass)
        expect(files[coinMain] || '').to.not.include('NODE_USER=')      // stripped from the main file
        expect(files[coinSidecar] || '').to.include('NODE_USER=' + gluedUser)  // relocated to the sidecar
    })

    it('HUB_DB_PASS falls back to the shared static default when rotation cannot apply it', async function () {
        const { cs, files } = makeMemoryConfigService()
        const coinCfg = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const hubCfg  = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
        expect(coinCfg['HUB_DB_PASS']).to.equal('xchain' + SEP + 'password')
        expect(hubCfg['HUB_DB_PASS']).to.equal(coinCfg['HUB_DB_PASS'])
        expect(files[hubSidecar]).to.equal(undefined)
    })

    it('HUB_DB_PASS is generated, shared, and persisted when rotation can apply it', async function () {
        const { cs, files } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
        const coinCfg = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const hubCfg  = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
        expect(coinCfg['HUB_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
        expect(coinCfg['HUB_DB_PASS']).to.not.equal('xchain' + SEP + 'password')
        expect(hubCfg['HUB_DB_PASS']).to.equal(coinCfg['HUB_DB_PASS'])
        expect(files[hubSidecar]).to.include('HUB_DB_PASS=')
    })

    // #2246: on the non-rotatable path INDEXER_DB_PASS is not yet in
    // defaultConfig when the indexer's HUB_DB_PASS bind runs, so the old
    // unconditional copy planted HUB_DB_PASS=undefined - the key then
    // "existed", the shared/static fallbacks skipped it, and the container
    // got HUB_DB_PASS="undefined" against an account whose password fell
    // through to the static default (HubDbSync ER_ACCESS_DENIED lockout).
    it('indexer HUB_DB_PASS matches the indexer account static default when rotation cannot apply (never undefined)', async function () {
        const { cs } = makeMemoryConfigService()
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
        expect(config['HUB_DB_PASS']).to.equal('xchain' + SEP + 'password')
        expect(config['HUB_DB_PASS']).to.equal(config['INDEXER_DB_PASS'])
    })

    it('indexer HUB_DB_PASS matches the generated per-install INDEXER_DB_PASS when rotation can apply', async function () {
        const { cs } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
        expect(config['INDEXER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
        expect(config['HUB_DB_PASS']).to.equal(config['INDEXER_DB_PASS'])
    })
}

function databaseCredentials3() {
    it('passes INDEXER_API_KEY through from host env to the indexer config (federation auth)', async function () {
        const prev = process.env.INDEXER_API_KEY
        process.env.INDEXER_API_KEY = 'fed-secret-123'
        try {
            const { cs } = makeMemoryConfigService()
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
            expect(config['INDEXER_API_KEY']).to.equal('fed-secret-123')
        } finally {
            if (prev === undefined) delete process.env.INDEXER_API_KEY
            else process.env.INDEXER_API_KEY = prev
        }
    })

    it('omits INDEXER_API_KEY when unset in host env (indexer stays fail-closed)', async function () {
        const prev = process.env.INDEXER_API_KEY
        delete process.env.INDEXER_API_KEY
        try {
            const { cs } = makeMemoryConfigService()
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
            expect(config['INDEXER_API_KEY']).to.equal(undefined)
            // mainnet/testnet must NOT get the keyless escape hatch.
            expect(config['INDEXER_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
        } finally {
            if (prev !== undefined) process.env.INDEXER_API_KEY = prev
        }
    })

    it('defaults INDEXER_ALLOW_UNAUTHENTICATED=true on keyless regtest installs (gated methods usable)', async function () {
        const prev = process.env.INDEXER_API_KEY
        delete process.env.INDEXER_API_KEY
        try {
            const { cs } = makeMemoryConfigService()
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
            expect(config['INDEXER_ALLOW_UNAUTHENTICATED']).to.equal('true')
        } finally {
            if (prev !== undefined) process.env.INDEXER_API_KEY = prev
        }
    })

    it('keeps regtest fail-closed when a host INDEXER_API_KEY is provided', async function () {
        const prev = process.env.INDEXER_API_KEY
        process.env.INDEXER_API_KEY = 'fed-secret-123'
        try {
            const { cs } = makeMemoryConfigService()
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
            expect(config['INDEXER_API_KEY']).to.equal('fed-secret-123')
            expect(config['INDEXER_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
        } finally {
            if (prev === undefined) delete process.env.INDEXER_API_KEY
            else process.env.INDEXER_API_KEY = prev
        }
    })
}

function databaseCredentials4() {
    it('returns correct UTXO_TRACKER_URL as Docker image name', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['UTXO_TRACKER_URL']).to.equal('xchain-node-bitcoin-mainnet-xchain-utxo-tracker')
    })

    it('returns correct DECODER_DB_NAME', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_NAME']).to.equal('XChain_BTC_Mainnet_Decoder')
    })

    it('returns correct INDEXER_DB_NAME', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
        expect(config['INDEXER_DB_NAME']).to.equal('XChain_BTC_Mainnet_Indexer')
    })
}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', databaseCredentials1)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', databaseCredentials2)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', databaseCredentials3)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', databaseCredentials4)
    })
})
