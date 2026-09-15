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
const proxyquire = require('proxyquire').noCallThru()
const { Readable } = require('stream')

// Helpers
function makeConfigService(fsStub, readlineOverride) {
    const constants = require('../../../src/config/index')
    const stubs = {
        'fs': fsStub || require('fs'),
        '../config/constants': {
            ...constants,
            configDir: '/test/config'
        },
        '../utils/helpers': { stringToCoin: (s) => s }
    }
    if (readlineOverride) {
        stubs['readline'] = readlineOverride
    }
    return proxyquire('../../../src/services/config_service', stubs)
}

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 2: Malformed config content (FS-03)
    describe('Experiment 2: Malformed config content', function () {

        it('skips lines without = delimiter', async function () {
            const configContent = 'THIS_LINE_HAS_NO_EQUALS\nNODE_PORT=9999\nANOTHER_BAD_LINE'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent.split('\n').map(l => l + '\n'))),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            // All defaults should still be present
            expect(config).to.have.property('NODE_PORT', '9999')
            expect(config).to.not.have.property('THIS_LINE_HAS_NO_EQUALS')
            expect(config).to.not.have.property('ANOTHER_BAD_LINE')
        })

        it('handles empty config file gracefully', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from('')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            // Should fall back to all defaults
            expect(config).to.have.property('NETWORK')
            expect(config).to.have.property('NODE_PORT', 8332)
        })
    })
})

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment 2: Malformed config content', function () {

        it('handles config with duplicate keys (last value wins)', async function () {
            const configContent = 'NODE_PORT=1111\nNODE_PORT=2222\nNODE_PORT=3333'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent.split('\n').map(l => l + '\n'))),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PORT', '3333')
        })

        it('handles config with values containing = signs', async function () {
            const configContent = 'NODE_PASSWORD=my=secret=password'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent + '\n')),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PASSWORD', 'my=secret=password')
        })
    })
})

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment 2: Malformed config content', function () {

        it('handles config with empty values', async function () {
            const configContent = 'NODE_PASSWORD='
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent + '\n')),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PASSWORD', '')
        })

        it('handles config with only whitespace lines', async function () {
            const configContent = '   \n\t\n  \n'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent)),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PORT', 8332)
        })
    })
})
