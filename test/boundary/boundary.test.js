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

const { HUB_MODULE_NAME } = require('../../src/config')

// Helpers
function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

function makeConfigService(fsStub) {
    return proxyquire('../../src/services/config_service', {
        'fs': fsStub || require('fs')
    })
}

function describeBoundaryTests(title, defineTests) {
    describe('Boundary Tests', function () {
        afterEach(function () {
            sinon.restore()
        })

        describe(title, defineTests)
    })
}

// 1. Config file parsing boundaries (Fix 1 & 2)
describeBoundaryTests('ConfigService: config file parsing', function () {
    describe('values containing "=" (Fix 1)', function () {

        it('preserves full value when it contains "="', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('NODE_PASSWORD=p@ss=word=123\n')),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('p@ss=word=123')
        })

        it('handles base64-encoded values with trailing "="', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('AUTH_TOKEN=dGVzdA==\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['AUTH_TOKEN']).to.equal('dGVzdA==')
        })

        it('handles value that is just "="', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('SEPARATOR==\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['SEPARATOR']).to.equal('=')
        })
    })
})
describeBoundaryTests('ConfigService: config file parsing', function () {
    describe('empty and blank config values', function () {

        it('handles empty value after "="', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('EMPTY_VAR=\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['EMPTY_VAR']).to.equal('')
        })

        it('skips blank lines', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('\n\nKEY=value\n\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['KEY']).to.equal('value')
        })

        it('skips lines without "="', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('no-equals-here\nKEY=value\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['no-equals-here']).to.be.undefined
            expect(config['KEY']).to.equal('value')
        })

        it('skips lines that start with "=" (no key)', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('=nokey\nKEY=value\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['']).to.be.undefined
            expect(config['KEY']).to.equal('value')
        })
    })
})

describeBoundaryTests('ConfigService: config file parsing', function () {
    describe('missing config file (Fix 2)', function () {

        it('falls back to defaults when config file does not exist', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            // Should have defaults, not crash
            expect(config['NODE_PORT']).to.equal(8332)
            // NODE_USER is randomly generated when absent; must be a non-empty, non-default string
            expect(config['NODE_USER']).to.be.a('string').with.length.greaterThan(0)
            expect(config['NODE_USER']).to.not.equal('rpc')
            expect(config['HUB_PORT']).to.equal(10000)

            // createReadStream should NOT have been called
            expect(fsStub.createReadStream.called).to.be.false
        })

        it('does not attempt file read for shared services (null coin/network)', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
            expect(config['HUB_PORT']).to.equal(10000)
            expect(fsStub.createReadStream.called).to.be.false
        })
    })
})

describeBoundaryTests('ConfigService: config file parsing', function () {
    describe('config file value override priority', function () {

        it('config file values override hardcoded defaults', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('NODE_PORT=9999\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PORT']).to.equal('9999')
        })

        it('hardcoded defaults fill in for keys not in config file', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => streamFromString('CUSTOM_KEY=custom\n')),
                appendFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['CUSTOM_KEY']).to.equal('custom')
            expect(config['NODE_PORT']).to.equal(8332)
        })
    })
})
