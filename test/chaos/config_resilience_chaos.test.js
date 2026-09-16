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
const path       = require('path')

// Helpers
function makeConfigService(fsStub, readlineOverride) {
    const constants = require('../../src/config/index')
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
    return proxyquire('../../src/services/config_service', stubs)
}

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 1: Config file missing (FS-01)
    describe('Experiment 1: Config file missing', function () {

        it('falls back to hardcoded defaults when config file does not exist', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const warnSpy = sinon.stub(console, 'warn')

            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')

            expect(config).to.have.property('NETWORK', 'regtest')
            expect(config).to.have.property('NODE_PORT', 18444)
            expect(config).to.have.property('DECODER_DB_HOST', 'mariadb')
            expect(warnSpy.calledOnce).to.be.true
            expect(warnSpy.firstCall.args[0]).to.include('config file not found')
        })

        it('still returns all required default keys when config file is missing', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            sinon.stub(console, 'warn')

            // These should NOT throw path traversal
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            const requiredKeys = [
                'NETWORK', 'NODE_URL', 'NODE_PORT', 'NODE_USER', 'NODE_PASSWORD',
                'DECODER_DB_HOST', 'DECODER_DB_PORT', 'ENCODER_URL', 'INDEXER_URL',
                'HUB_HOST', 'HUB_PORT'
            ]
            for (const key of requiredKeys) {
                expect(config).to.have.property(key)
            }
        })
    })
})

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 1b: Config file unreadable (FS-02)
    describe('Experiment 1b: Config file unreadable (permission denied)', function () {

        it('propagates stream error when config file cannot be read', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => {
                    const s = new Readable({ read() { this.destroy(new Error('EACCES: permission denied')) } })
                    return s
                }),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)

            try {
                await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('EACCES')
            }
        })
    })
})
