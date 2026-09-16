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

// The hub refuses to boot on an UNDECLARED unauthenticated
// write surface. A managed keyless deploy is still legitimate, so the
// deployer makes the declaration; without it the container would
// crash-loop the way over-tightening the indexer (771880c) and the
// encoder (e2bf7c4) did pre-launch.
function hubKeylessDeclaration() {
    async function hubConfigWith(env) {
        const saved = {}
        for (const k of ['HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED', 'HUB_NETWORK']) {
            saved[k] = process.env[k]
            delete process.env[k]
        }
        Object.assign(process.env, env)
        try {
            const cs = makeServiceWithConfig('')
            return await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    }

    it('declares keyless operation when no HUB_API_KEY is in the host env', async function () {
        const cfg = await hubConfigWith({})
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
    })

    it('does not declare keyless when a key is present (the hub is keyed)', async function () {
        const cfg = await hubConfigWith({ HUB_API_KEY: 'hub-secret-456' })
        expect(cfg['HUB_API_KEY']).to.equal('hub-secret-456')
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
    })

    it('yields to an explicit host-env refusal (HUB_ALLOW_UNAUTHENTICATED=false)', async function () {
        const cfg = await hubConfigWith({ HUB_ALLOW_UNAUTHENTICATED: 'false' })
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('false')
    })

    // Real funds behind it: on mainnet the deployer does NOT declare
    // keyless for the operator, so the hub's refusal stands and the
    // deploy fails loudly and prevents an open write surface.
    it('does NOT declare keyless on a mainnet hub', async function () {
        const cfg = await hubConfigWith({ HUB_NETWORK: 'mainnet' })
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
    })

    it('still declares keyless on a regtest hub', async function () {
        const cfg = await hubConfigWith({ HUB_NETWORK: 'regtest' })
        expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
    })

}

function hubNetworkPassthrough() {
    let saved
    beforeEach(function () { saved = process.env.HUB_NETWORK; delete process.env.HUB_NETWORK })
    afterEach(function () { if (saved === undefined) delete process.env.HUB_NETWORK; else process.env.HUB_NETWORK = saved })

    it('injects HUB_NETWORK from host env into the hub config', async function () {
        process.env.HUB_NETWORK = 'mainnet'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['HUB_NETWORK']).to.equal('mainnet')
    })

    it('leaves HUB_NETWORK unset when host env is absent (standalone unchanged)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['HUB_NETWORK']).to.be.undefined
    })

    // The guard on the guard: the test above only describes a standalone
    // install while ValidatorService is stubbed out. Unstubbed it reads the
    // real config/validator/ through its own fs binding, so on any box that
    // has run `validator init` the suite both fails here and pulls that
    // machine's live signing key into a fixture. Assert the validator env is
    // absent, which is the shape only an isolated read can produce.
    it('reads no validator identity off the host filesystem', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['SIGNING_PRIVKEY_HEX']).to.be.undefined
        expect(config['P2P_VALIDATOR_ADDR']).to.be.undefined
        expect(config['HUB_CAPABILITY_CONFIG']).to.be.undefined
    })

}

// The five PRICE batch knobs: non-consensus, so a passthrough
// omission just leaves the hub on its own default rather than drifting
// a federation, but an operator install still needs them to reach the
// container to tune window/grace/timeout/buffer/landing-reserve at all.
function oracleBatchPassthrough() {
    const ORACLE_BATCH_VARS = [
        'ORACLE_BATCH_WINDOW_ROUNDS', 'ORACLE_BATCH_GRACE_MS',
        'ORACLE_BATCH_SIGN_TIMEOUT_MS', 'ORACLE_BATCH_BUFFER_MAX_ROUNDS',
        'ORACLE_BATCH_LANDING_RESERVE_MS'
    ]
    let saved
    beforeEach(function () {
        saved = {}
        for (const k of ORACLE_BATCH_VARS) { saved[k] = process.env[k]; delete process.env[k] }
    })
    afterEach(function () {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    it('injects all five ORACLE_BATCH_* knobs from host env into the hub config', async function () {
        process.env.ORACLE_BATCH_WINDOW_ROUNDS = '2'
        process.env.ORACLE_BATCH_GRACE_MS = '300000'
        process.env.ORACLE_BATCH_SIGN_TIMEOUT_MS = '60000'
        process.env.ORACLE_BATCH_BUFFER_MAX_ROUNDS = '4032'
        process.env.ORACLE_BATCH_LANDING_RESERVE_MS = '300000'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['ORACLE_BATCH_WINDOW_ROUNDS']).to.equal('2')
        expect(config['ORACLE_BATCH_GRACE_MS']).to.equal('300000')
        expect(config['ORACLE_BATCH_SIGN_TIMEOUT_MS']).to.equal('60000')
        expect(config['ORACLE_BATCH_BUFFER_MAX_ROUNDS']).to.equal('4032')
        expect(config['ORACLE_BATCH_LANDING_RESERVE_MS']).to.equal('300000')
    })

    it('leaves all five ORACLE_BATCH_* knobs unset when host env is absent (hub default unchanged)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        for (const k of ORACLE_BATCH_VARS) expect(config[k]).to.be.undefined
    })

}

// The hub-side regtest-only override seams. The gate that keeps
// them inert off regtest lives at the point of consumption (attest_response_timing.js,
// and the not-yet-built AttestationBatchPublisher on the same pattern), so this
// suite only pins that the passthrough itself reaches the container config.
function attestOverridePassthrough() {
    const ATTEST_OVERRIDE_VARS = [
        'ATTEST_RESPONSE_FORWARD_S_OVERRIDE', 'ATTEST_BATCH_WINDOW_S_OVERRIDE'
    ]
    let saved
    beforeEach(function () {
        saved = {}
        for (const k of ATTEST_OVERRIDE_VARS) { saved[k] = process.env[k]; delete process.env[k] }
    })
    afterEach(function () {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    it('injects both ATTEST override knobs from host env into the hub config', async function () {
        process.env.ATTEST_RESPONSE_FORWARD_S_OVERRIDE = '2'
        process.env.ATTEST_BATCH_WINDOW_S_OVERRIDE = '30'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['ATTEST_RESPONSE_FORWARD_S_OVERRIDE']).to.equal('2')
        expect(config['ATTEST_BATCH_WINDOW_S_OVERRIDE']).to.equal('30')
    })

    it('injects only the one override set, leaving the other unset', async function () {
        process.env.ATTEST_RESPONSE_FORWARD_S_OVERRIDE = '2'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['ATTEST_RESPONSE_FORWARD_S_OVERRIDE']).to.equal('2')
        expect(config).to.not.have.property('ATTEST_BATCH_WINDOW_S_OVERRIDE')
    })

    it('leaves both ATTEST override knobs unset when host env is absent', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        for (const k of ATTEST_OVERRIDE_VARS) expect(config[k]).to.be.undefined
    })

}

// The per-coin confirmation depth the hub's cross-chain engines gate a source
// leg on. A regtest venue pins it to 1 so a bridge lock finalizes on the next
// block; the hub clamps a value below the per-coin default up to that default
// off regtest, so the passthrough is inert on mainnet and testnet. This suite
// pins that the three names reach the hub config from the host env and that an
// unset one leaves the hub on its own default.
function confirmationsPassthrough() {
    const CONFIRMATION_VARS = [
        'XCHAIN_CONFIRMATIONS_BTC', 'XCHAIN_CONFIRMATIONS_LTC', 'XCHAIN_CONFIRMATIONS_DOGE'
    ]
    let saved
    beforeEach(function () {
        saved = {}
        for (const k of CONFIRMATION_VARS) { saved[k] = process.env[k]; delete process.env[k] }
    })
    afterEach(function () {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    it('injects all three XCHAIN_CONFIRMATIONS_* depths from host env into the hub config', async function () {
        process.env.XCHAIN_CONFIRMATIONS_BTC = '1'
        process.env.XCHAIN_CONFIRMATIONS_LTC = '1'
        process.env.XCHAIN_CONFIRMATIONS_DOGE = '1'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['XCHAIN_CONFIRMATIONS_BTC']).to.equal('1')
        expect(config['XCHAIN_CONFIRMATIONS_LTC']).to.equal('1')
        expect(config['XCHAIN_CONFIRMATIONS_DOGE']).to.equal('1')
    })

    it('injects only the one depth set, leaving the other two absent', async function () {
        process.env.XCHAIN_CONFIRMATIONS_BTC = '2'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['XCHAIN_CONFIRMATIONS_BTC']).to.equal('2')
        expect(config).to.not.have.property('XCHAIN_CONFIRMATIONS_LTC')
        expect(config).to.not.have.property('XCHAIN_CONFIRMATIONS_DOGE')
    })

    it('leaves all three depths absent when the host env carries none (hub default unchanged)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        for (const k of CONFIRMATION_VARS) expect(config).to.not.have.property(k)
    })

}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', function () {
            describe('hub keyless declaration', hubKeylessDeclaration)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', function () {
            describe('XCHAIN_CONFIRMATIONS_* passthrough', confirmationsPassthrough)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', function () {
            describe('HUB_NETWORK passthrough', hubNetworkPassthrough)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', function () {
            describe('ORACLE_BATCH_* passthrough', oracleBatchPassthrough)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('without coin/network (shared service config)', function () {
            describe('ATTEST response mirror regtest-only override passthrough', attestOverridePassthrough)
        })
    })
})
