'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { Readable } = require('stream')

const {
    Coin, Network, XChainService, HUB_MODULE_NAME, EXPLORER_MODULE_NAME
} = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

function makeServiceWithConfig(configContent) {
    const fsStub = {
        createReadStream: sinon.stub().returns(streamFromString(configContent)),
        existsSync: sinon.stub().returns(true),
        rmSync: sinon.stub(),
        mkdirSync: sinon.stub()
    }
    return proxyquire('../../src/services/ConfigService', { 'fs': fsStub })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Config File Parsing', function () {

    // --- Structural fuzzing of KEY=VALUE format ---

    it('handles line with no equals sign (ignored)', async function () {
        const cs = makeServiceWithConfig('NO_EQUALS_HERE\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config).to.not.have.property('NO_EQUALS_HERE')
        // Default values should still be present
        expect(config['NODE_PORT']).to.equal(8332)
    })

    it('handles line with empty key (= at start)', async function () {
        const cs = makeServiceWithConfig('=some_value\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        // eqIndex would be 0, which is not > 0, so this line should be skipped
        expect(config).to.not.have.property('')
    })

    it('handles line with multiple equals signs (value contains =)', async function () {
        const cs = makeServiceWithConfig('KEY=value=with=equals\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['KEY']).to.equal('value=with=equals')
    })

    it('handles line with empty value', async function () {
        const cs = makeServiceWithConfig('EMPTY_VAL=\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['EMPTY_VAL']).to.equal('')
    })

    it('handles empty config file', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        // All defaults should be present
        expect(config['NODE_PORT']).to.equal(8332)
        expect(config['ENCODER_API_PORT']).to.equal(3003)
    })

    it('handles config file with only blank lines', async function () {
        const cs = makeServiceWithConfig('\n\n\n\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NODE_PORT']).to.equal(8332)
    })

    it('handles config file with no trailing newline', async function () {
        const cs = makeServiceWithConfig('NODE_EXPOSED_PORT=3000')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NODE_EXPOSED_PORT']).to.equal('3000')
    })

    it('handles carriage return line endings', async function () {
        const cs = makeServiceWithConfig('KEY1=val1\r\nKEY2=val2\r\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        // readline with crlfDelay: Infinity should handle this
        expect(config['KEY1']).to.exist
        expect(config['KEY2']).to.exist
    })

    // --- Value fuzzing: injection payloads in config values ---

    const dangerousValues = [
        ['shell metachar semicolon',  'EVIL=value; rm -rf /'],
        ['shell metachar backtick',   'EVIL=value`id`'],
        ['shell metachar dollar',     'EVIL=value$(whoami)'],
        ['SQL injection',             "EVIL='; DROP TABLE users; --"],
        ['path traversal',            'EVIL=../../../etc/passwd'],
        ['newline injection',         'EVIL=value\\n-v /:/host'],
        ['extremely long value',      'EVIL=' + 'A'.repeat(10000)],
        ['null byte',                 'EVIL=val\x00ue'],
        ['unicode BOM',              '\uFEFFEVIL=value'],
    ]

    for (const [desc, line] of dangerousValues) {
        it(`does not crash on config value: ${desc}`, async function () {
            const cs = makeServiceWithConfig(line + '\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            // Should not crash; defaults should still be present
            expect(config).to.be.an('object')
            expect(config['NODE_PORT']).to.equal(8332)
        })
    }

    // --- Port value fuzzing ---

    const fuzzedPorts = [
        ['negative port',        'ENCODER_PORT=-1',        '-1'],
        ['zero port',            'ENCODER_PORT=0',         '0'],
        ['port above range',     'ENCODER_PORT=65536',     '65536'],
        ['huge port',            'ENCODER_PORT=99999',     '99999'],
        ['float port',           'ENCODER_PORT=3.14',      '3.14'],
        ['NaN port',             'ENCODER_PORT=NaN',       'NaN'],
        ['hex port',             'ENCODER_PORT=0x1F90',    '0x1F90'],
        ['string port',          'ENCODER_PORT=abc',       'abc'],
        ['injection port',       'ENCODER_PORT=3000; rm -rf /', '3000; rm -rf /'],
        ['empty port',           'ENCODER_PORT=',          ''],
    ]

    for (const [desc, line, expected] of fuzzedPorts) {
        it(`config file port override is stored as-is: ${desc}`, async function () {
            const cs = makeServiceWithConfig(line + '\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['ENCODER_PORT']).to.equal(expected)
        })
    }

    // --- Key fuzzing ---

    it('handles key with special characters', async function () {
        const cs = makeServiceWithConfig('KEY WITH SPACES=value\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['KEY WITH SPACES']).to.equal('value')
    })

    it('handles key with only digits', async function () {
        const cs = makeServiceWithConfig('12345=value\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['12345']).to.equal('value')
    })

    it('config file values override defaults but do not remove unmentioned defaults', async function () {
        const cs = makeServiceWithConfig('NODE_PORT=9999\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        // Overridden
        expect(config['NODE_PORT']).to.equal('9999')
        // Other defaults still present
        expect(config['ENCODER_API_PORT']).to.equal(3003)
        expect(config['HUB_PORT']).to.equal(10000)
    })

    // --- Large config file ---

    it('handles config file with 1000 lines', async function () {
        const lines = Array.from({ length: 1000 }, (_, i) => `KEY_${i}=value_${i}`).join('\n')
        const cs = makeServiceWithConfig(lines + '\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['KEY_0']).to.equal('value_0')
        expect(config['KEY_999']).to.equal('value_999')
        // Defaults still present for unoverridden keys
        expect(config['NODE_PORT']).to.equal(8332)
    })

    // --- Missing config file ---

    it('uses defaults when config file does not exist', async function () {
        const fsStub = {
            createReadStream: sinon.stub(),
            existsSync: sinon.stub().returns(false),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        }
        const cs = proxyquire('../../src/services/ConfigService', { 'fs': fsStub })
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NODE_PORT']).to.equal(8332)
        expect(config['ENCODER_API_PORT']).to.equal(3003)
    })

    // --- Shared service config (no coin/network) ---

    it('returns shared config when coin and network are null', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
        expect(config['HUB_PORT']).to.equal(10000)
        expect(config).to.not.have.property('NODE_PORT')
    })

    it('returns shared config when coin and network are empty strings', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, '', '')
        expect(config['EXPLORER_PORT_HTTP']).to.equal(18080)
        expect(config).to.not.have.property('DECODER_DB_NAME')
    })
})
