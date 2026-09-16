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

// Encoder passthrough (rate-limits-that-fit-the-wallet D7/D8/C8, row 12):
// ENCODER_TRUST_PROXY and ENCODER_RATE_LIMIT_RPM survive an
// update/recreate only if they ride the host env into the container's
// default config, mirroring the explorer serving-limit passthrough below.
function encoderPassthrough1() {
    it('passes ENCODER_TRUST_PROXY and ENCODER_RATE_LIMIT_RPM through from the host env', async function () {
        const prev = {
            proxy: process.env.ENCODER_TRUST_PROXY,
            rpm:   process.env.ENCODER_RATE_LIMIT_RPM
        }
        process.env.ENCODER_TRUST_PROXY    = '203.0.113.9'
        process.env.ENCODER_RATE_LIMIT_RPM = '240'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect(config['ENCODER_TRUST_PROXY']).to.equal('203.0.113.9')
            expect(config['ENCODER_RATE_LIMIT_RPM']).to.equal('240')
        } finally {
            for (const [k, v] of [
                ['ENCODER_TRUST_PROXY', prev.proxy],
                ['ENCODER_RATE_LIMIT_RPM', prev.rpm]
            ]) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    })

    it('emits neither key when the host env carries no encoder passthrough values', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(config).to.not.have.property('ENCODER_TRUST_PROXY')
        expect(config).to.not.have.property('ENCODER_RATE_LIMIT_RPM')
    })

    // The regtest block above sets ENCODER_RATE_LIMIT_RPM=99999 unconditionally
    // (a bursty e2e-suite accommodation); this passthrough runs AFTER it, so an
    // operator's host value still wins on a regtest venue.
    it('lets a host ENCODER_RATE_LIMIT_RPM win over the regtest 99999 literal', async function () {
        const prev = process.env.ENCODER_RATE_LIMIT_RPM
        process.env.ENCODER_RATE_LIMIT_RPM = '300'
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(XChainService.XCHAIN_ENCODER, 'bitcoin', 'regtest')
            expect(config['ENCODER_RATE_LIMIT_RPM']).to.equal('300')
        } finally {
            if (prev === undefined) delete process.env.ENCODER_RATE_LIMIT_RPM
            else process.env.ENCODER_RATE_LIMIT_RPM = prev
        }
    })

    it('keeps the regtest 99999 literal when the host env sets no override', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_ENCODER, 'bitcoin', 'regtest')
        expect(config['ENCODER_RATE_LIMIT_RPM']).to.equal(99999)
    })
}

function encoderPassthrough2() {
    // Gated on module === XCHAIN_ENCODER; a decoder or utxo-tracker config
    // for the same coin/network must never pick this up.
    it('does not leak the encoder passthrough onto decoder or utxo-tracker configs', async function () {
        const prev = {
            proxy: process.env.ENCODER_TRUST_PROXY,
            rpm:   process.env.ENCODER_RATE_LIMIT_RPM
        }
        process.env.ENCODER_TRUST_PROXY    = '203.0.113.9'
        process.env.ENCODER_RATE_LIMIT_RPM = '240'
        try {
            const cs = makeServiceWithConfig('')
            const decoderConfig = await cs.getDefaultConfig(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')
            expect(decoderConfig).to.not.have.property('ENCODER_TRUST_PROXY')
            expect(decoderConfig).to.not.have.property('ENCODER_RATE_LIMIT_RPM')
            const trackerConfig = await cs.getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(trackerConfig).to.not.have.property('ENCODER_TRUST_PROXY')
            expect(trackerConfig).to.not.have.property('ENCODER_RATE_LIMIT_RPM')
        } finally {
            for (const [k, v] of [
                ['ENCODER_TRUST_PROXY', prev.proxy],
                ['ENCODER_RATE_LIMIT_RPM', prev.rpm]
            ]) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    })
}

// LEVELDB_CACHE_BYTES is documented at
// components/utxo-tracker/configuration.md:41 and src/store/level_up_db.js reads it from
// process.env inside the container, but getDefaultConfig never forwarded the
// host var into the tracker's own config, so an operator exporting it got
// silence on install/update/recreate.
function leveldbTuningPassthrough() {
    it('passes LEVELDB_CACHE_BYTES and LEVELDB_WRITE_BUFFER_BYTES through from the host env', async function () {
        const prev = {
            cache: process.env.LEVELDB_CACHE_BYTES,
            wbuf:  process.env.LEVELDB_WRITE_BUFFER_BYTES
        }
        process.env.LEVELDB_CACHE_BYTES        = String(8 * 1024 * 1024 * 1024)
        process.env.LEVELDB_WRITE_BUFFER_BYTES = String(128 * 1024 * 1024)
        try {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(config['LEVELDB_CACHE_BYTES']).to.equal(String(8 * 1024 * 1024 * 1024))
            expect(config['LEVELDB_WRITE_BUFFER_BYTES']).to.equal(String(128 * 1024 * 1024))
        } finally {
            for (const [k, v] of [
                ['LEVELDB_CACHE_BYTES', prev.cache],
                ['LEVELDB_WRITE_BUFFER_BYTES', prev.wbuf]
            ]) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    })

    it('emits neither key when the host env carries no LevelDB passthrough values', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
        expect(config).to.not.have.property('LEVELDB_CACHE_BYTES')
        expect(config).to.not.have.property('LEVELDB_WRITE_BUFFER_BYTES')
    })

    // Gated on module === XCHAIN_UTXO_TRACKER; an encoder or decoder config
    // for the same coin/network must never pick this up.
    it('does not leak the LevelDB passthrough onto encoder or decoder configs', async function () {
        const prev = process.env.LEVELDB_CACHE_BYTES
        process.env.LEVELDB_CACHE_BYTES = String(8 * 1024 * 1024 * 1024)
        try {
            const cs = makeServiceWithConfig('')
            const encoderConfig = await cs.getDefaultConfig(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect(encoderConfig).to.not.have.property('LEVELDB_CACHE_BYTES')
            const decoderConfig = await cs.getDefaultConfig(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')
            expect(decoderConfig).to.not.have.property('LEVELDB_CACHE_BYTES')
        } finally {
            if (prev === undefined) delete process.env.LEVELDB_CACHE_BYTES
            else process.env.LEVELDB_CACHE_BYTES = prev
        }
    })


}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('encoder passthrough (ENCODER_TRUST_PROXY / ENCODER_RATE_LIMIT_RPM)', encoderPassthrough1)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('encoder passthrough (ENCODER_TRUST_PROXY / ENCODER_RATE_LIMIT_RPM)', encoderPassthrough2)
        })
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', function () {
            describe('LevelDB tuning passthrough (LEVELDB_CACHE_BYTES / LEVELDB_WRITE_BUFFER_BYTES)', leveldbTuningPassthrough)
        })
    })
})
