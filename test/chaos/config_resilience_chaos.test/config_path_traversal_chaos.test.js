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

    // Experiment 12: Config path traversal (FS-09)
    describe('Experiment 12: Config path traversal', function () {

        it('blocks basic path traversal with ../', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from('')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)

            try {
                await cs.getDefaultConfig('xchain-encoder', '../../etc', 'passwd')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('path traversal')
            }
        })

        it('blocks traversal with encoded separators in coin name', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from('')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)

            try {
                await cs.getDefaultConfig('xchain-encoder', '../..', 'etc/passwd')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('path traversal')
            }
        })
    })
})

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment 12: Config path traversal', function () {

        it('allows valid coin-network combinations', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            sinon.stub(console, 'warn')

            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config).to.have.property('NETWORK')
        })
    })
})
