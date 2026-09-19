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

// The passthrough is the only supported way to arm a DEPLOYED indexer for
// ROLLCALL, and the only way its DOGE proof peer survives an `update`.
function rollcallPassthrough1() {
    const ROLLCALL_VARS = [
        'DOGE_INDEXER_API_URL', 'DOGE_INDEXER_API_KEY', 'XC_ROLLCALL_REGTEST_ACTIVATION',
        'XC_ROLLCALL_GATES_REGTEST_ACTIVATION'
    ]

    let saved

    beforeEach(function () {
        saved = {}
        for (const v of ROLLCALL_VARS) { saved[v] = process.env[v]; delete process.env[v] }
    })

    afterEach(function () {
        for (const v of ROLLCALL_VARS) {
            if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
        }
    })

    it('passes the DOGE proof peer through to the indexer on regtest', async function () {
        process.env.DOGE_INDEXER_API_URL = 'http://dogecoin-regtest-indexer:3004/api'
        process.env.DOGE_INDEXER_API_KEY = 'not-a-real-key'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['DOGE_INDEXER_API_URL']).to.equal('http://dogecoin-regtest-indexer:3004/api')
        expect(config['DOGE_INDEXER_API_KEY']).to.equal('not-a-real-key')
    })

    // Roll calls land on DOGE on every network, so the close needs a reachable
    // DOGE indexer on testnet and mainnet too, not only on the acceptance venue.
    it('passes the DOGE proof peer through on testnet as well', async function () {
        process.env.DOGE_INDEXER_API_URL = 'https://doge.example.invalid/api'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'testnet')
        expect(config['DOGE_INDEXER_API_URL']).to.equal('https://doge.example.invalid/api')
    })

    it('arms the indexer on regtest when the host opts in', async function () {
        process.env.XC_ROLLCALL_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['XC_ROLLCALL_REGTEST_ACTIVATION']).to.equal('armed')
    })

    it('carries a bare arming height through unaltered', async function () {
        process.env.XC_ROLLCALL_REGTEST_ACTIVATION = '900'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['XC_ROLLCALL_REGTEST_ACTIVATION']).to.equal('900')
    })
}

function rollcallPassthrough2() {
    const ROLLCALL_VARS = [
        'DOGE_INDEXER_API_URL', 'DOGE_INDEXER_API_KEY', 'XC_ROLLCALL_REGTEST_ACTIVATION',
        'XC_ROLLCALL_GATES_REGTEST_ACTIVATION'
    ]

    let saved

    beforeEach(function () {
        saved = {}
        for (const v of ROLLCALL_VARS) { saved[v] = process.env[v]; delete process.env[v] }
    })

    afterEach(function () {
        for (const v of ROLLCALL_VARS) {
            if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
        }
    })

    // The deploy path is the SECOND gate. rollcall_activation.js cannot reach
    // the environment for a shared-ledger network at all, and this makes the
    // host variable stop at the container door there as well, so neither gate
    // being edited alone can arm mainnet or testnet from a host variable.
    it('NEVER arms a shared-ledger indexer, whatever the host env says', async function () {
        process.env.XC_ROLLCALL_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        for (const net of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', net)
            expect(config, net).to.not.have.property('XC_ROLLCALL_REGTEST_ACTIVATION')
        }
    })

    it('does NOT inject the rollcall vars into a non-indexer coin module (decoder)', async function () {
        process.env.DOGE_INDEXER_API_URL           = 'http://x/api'
        process.env.XC_ROLLCALL_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
        expect(config).to.not.have.property('DOGE_INDEXER_API_URL')
        expect(config).to.not.have.property('XC_ROLLCALL_REGTEST_ACTIVATION')
    })

    // ROLLCALL_ACTIVATION is a consensus_rules_digest SHARED_GATE, so an armed
    // indexer beside an inert container hub reports a rules mismatch. A venue
    // has to arm as a unit, which means the hub takes the same variable.
    it('arms the container hub from the same variable, so the venue arms as a unit', async function () {
        process.env.XC_ROLLCALL_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(config['XC_ROLLCALL_REGTEST_ACTIVATION']).to.equal('armed')
    })
}

function rollcallPassthrough3() {
    const ROLLCALL_VARS = [
        'DOGE_INDEXER_API_URL', 'DOGE_INDEXER_API_KEY', 'XC_ROLLCALL_REGTEST_ACTIVATION',
        'XC_ROLLCALL_GATES_REGTEST_ACTIVATION'
    ]

    let saved

    beforeEach(function () {
        saved = {}
        for (const v of ROLLCALL_VARS) { saved[v] = process.env[v]; delete process.env[v] }
    })

    afterEach(function () {
        for (const v of ROLLCALL_VARS) {
            if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
        }
    })

    // XC_ROLLCALL_GATES_REGTEST_ACTIVATION (D84) follows the same ROLLCALL rail
    // env-derived regtest shape: it arms ROLLCALL v1 and the rules-aware
    // attestation set separately from the rail, so a venue can drive v0 as its
    // control. Both gates pass through identically at both sites (spec §8, D64).
    it('arms the indexer gates flag on regtest when the host opts in', async function () {
        process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['XC_ROLLCALL_GATES_REGTEST_ACTIVATION']).to.equal('armed')
    })

    it('NEVER arms the gates flag on a shared-ledger indexer, whatever the host env says', async function () {
        process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        for (const net of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', net)
            expect(config, net).to.not.have.property('XC_ROLLCALL_GATES_REGTEST_ACTIVATION')
        }
    })

    it('arms the container hub gates flag from the same variable, so the venue arms as a unit', async function () {
        process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = 'armed'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(config['XC_ROLLCALL_GATES_REGTEST_ACTIVATION']).to.equal('armed')
    })

    it('omits every rollcall var when unset, so a venue ships INERT', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        for (const v of ROLLCALL_VARS) expect(config).to.not.have.property(v)
        const hub = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(hub).to.not.have.property('XC_ROLLCALL_REGTEST_ACTIVATION')
        expect(hub).to.not.have.property('XC_ROLLCALL_GATES_REGTEST_ACTIVATION')
    })
}

// XC_MIRROR_ADMISSION_ACTIVATION (D84 precedent, row 24x): follows the same
// env-derived regtest shape as the ROLLCALL gates above. It arms the
// admission-map mirror producer, consumer and the anchor-attest barrier
// together at one height, so a venue arms as a unit the same way ROLLCALL does.
function mirrorAdmissionPassthrough() {
    const MIRROR_ADMISSION_VARS = ['XC_MIRROR_ADMISSION_ACTIVATION']

    let saved

    beforeEach(function () {
        saved = {}
        for (const v of MIRROR_ADMISSION_VARS) { saved[v] = process.env[v]; delete process.env[v] }
    })

    afterEach(function () {
        for (const v of MIRROR_ADMISSION_VARS) {
            if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
        }
    })

    it('arms the indexer on regtest when the host opts in', async function () {
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = '5124'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['XC_MIRROR_ADMISSION_ACTIVATION']).to.equal('5124')
    })

    it('NEVER arms a shared-ledger indexer, whatever the host env says', async function () {
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = '5124'
        const cs = makeServiceWithConfig('')
        for (const net of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', net)
            expect(config, net).to.not.have.property('XC_MIRROR_ADMISSION_ACTIVATION')
        }
    })

    it('does NOT inject the var into a non-indexer coin module (decoder)', async function () {
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = '5124'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
        expect(config).to.not.have.property('XC_MIRROR_ADMISSION_ACTIVATION')
    })

    // One variable arms producer, consumer and the anchor-attest barrier
    // together; the hub carries the producer side, so it must take the same
    // variable or the indexer's consumer arms with no producer to match it.
    it('arms the container hub from the same variable, so the venue arms as a unit', async function () {
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = '5124'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(config['XC_MIRROR_ADMISSION_ACTIVATION']).to.equal('5124')
    })

    it('omits the var when unset, so a venue ships INERT', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config).to.not.have.property('XC_MIRROR_ADMISSION_ACTIVATION')
        const hub = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(hub).to.not.have.property('XC_MIRROR_ADMISSION_ACTIVATION')
    })
}

// Regtest mirror arming: the regtest indexer's hub-mirror connection, unset
// before this row, and the three watermark graces that must be zeroed alongside
// it or an armed regtest venue wedges every freshly mined block (the price-grace
// failure the regtest mirror wedge records).
function regtestMirrorArming() {
    const GRACE_VARS = [
        'HUB_SYNC_PRICE_GRACE_S', 'HUB_SYNC_ORACLE_GRACE_S', 'HUB_SYNC_ATTEST_RESPONSE_GRACE_S',
        'HUB_SYNC_MATCH_GRACE_S', 'HUB_SYNC_CALL_GRACE_S', 'HUB_SYNC_ANCHOR_ATTEST_GRACE_S'
    ]
    let saved
    beforeEach(function () {
        saved = {}
        for (const v of GRACE_VARS) { saved[v] = process.env[v]; delete process.env[v] }
    })
    afterEach(function () {
        for (const v of GRACE_VARS) {
            if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
        }
    })

    it('arms the regtest indexer hub-mirror pointer at its own DB account', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['HUB_DB_NAME']).to.equal(config['INDEXER_DB_NAME'])
        expect(config['HUB_DB_USER']).to.equal(config['INDEXER_DB_USER'])
        expect(config['HUB_DB_SYNC_ENABLED']).to.equal('true')
        // The password must follow the same account, or the armed mirror
        // authenticates as the indexer's own DB user with the wrong password.
        expect(config['HUB_DB_PASS']).to.equal(config['INDEXER_DB_PASS'])
    })

    it('defaults all three watermark graces to 0 on regtest when the host sets none of them', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        for (const v of GRACE_VARS) expect(config[v], v).to.equal('0')
    })

    it('lets a host-set grace value win over the regtest default', async function () {
        process.env.HUB_SYNC_ATTEST_RESPONSE_GRACE_S = '30'
        process.env.HUB_SYNC_PRICE_GRACE_S = '15'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['HUB_SYNC_ATTEST_RESPONSE_GRACE_S']).to.equal('30')
        expect(config['HUB_SYNC_PRICE_GRACE_S']).to.equal('15')
        // The var left unset by the host still gets the regtest default.
        expect(config['HUB_SYNC_ORACLE_GRACE_S']).to.equal('0')
    })

    it('leaves mainnet/testnet mirror arming exactly as before (same account, no grace defaults)', async function () {
        process.env.HUB_SYNC_ATTEST_RESPONSE_GRACE_S = '30' // must be ignored off regtest
        const cs = makeServiceWithConfig('')
        for (const network of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', network)
            expect(config['HUB_DB_NAME'], network).to.equal(config['INDEXER_DB_NAME'])
            expect(config['HUB_DB_USER'], network).to.equal(config['INDEXER_DB_USER'])
            expect(config['HUB_DB_SYNC_ENABLED'], network).to.equal('true')
            expect(config['HUB_DB_PASS'], network).to.equal(config['INDEXER_DB_PASS'])
            for (const v of GRACE_VARS) expect(config, network + ' ' + v).to.not.have.property(v)
        }
    })

}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('ROLLCALL rail passthrough', rollcallPassthrough1)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('ROLLCALL rail passthrough', rollcallPassthrough2)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('ROLLCALL rail passthrough', rollcallPassthrough3)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('regtest mirror arming', regtestMirrorArming)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('MIRROR ADMISSION passthrough', mirrorAdmissionPassthrough)
        })
    })
})
