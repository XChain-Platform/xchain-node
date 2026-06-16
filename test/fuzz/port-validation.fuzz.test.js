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

const { XChainService } = require('../../src/config/constants')
const { validatePort } = require('../../src/services/ConfigService')

// ---------------------------------------------------------------------------
// validatePort() unit tests
// ---------------------------------------------------------------------------

describe('Fuzz: validatePort()', function () {

    // --- Valid ports ---

    const validPorts = [1, 80, 443, 3000, 3306, 8080, 8332, 8443, 18080, 65535]

    for (const port of validPorts) {
        it(`accepts valid port: ${port}`, function () {
            expect(validatePort(port)).to.be.true
        })
    }

    it('accepts port as string "3000"', function () {
        expect(validatePort('3000')).to.be.true
    })

    it('accepts port as string "1"', function () {
        expect(validatePort('1')).to.be.true
    })

    it('accepts port as string "65535"', function () {
        expect(validatePort('65535')).to.be.true
    })

    // --- Invalid ports ---

    const invalidPorts = [
        ['zero',              0],
        ['negative',          -1],
        ['negative large',    -65535],
        ['above range',       65536],
        ['very large',        99999],
        ['huge number',       1000000],
        ['float',             3.14],
        ['float string',      '3.14'],
        ['NaN',               NaN],
        ['NaN string',        'NaN'],
        ['Infinity',          Infinity],
        ['-Infinity',         -Infinity],
        ['Infinity string',   'Infinity'],
        ['empty string',      ''],
        ['alphabetic',        'abc'],
        ['hex string',        '0x1F90'],  // rejected: not purely digits
        ['injection',         '3000; rm -rf /'],
        ['null',              null],
        ['undefined',         undefined],
        ['boolean true',      true],
        ['boolean false',     false],
        ['object',            {}],
        ['array',             []],
        ['scientific notation', '1e4'],
    ]

    for (const [desc, value] of invalidPorts) {
        it(`rejects invalid port: ${desc} (${JSON.stringify(value)})`, function () {
            expect(validatePort(value)).to.be.false
        })
    }
})

// ---------------------------------------------------------------------------
// Port validation in buildAndUp()
// ---------------------------------------------------------------------------

describe('Fuzz: Port Validation in buildAndUp()', function () {

    function loadModuleService(envVars) {
        const stubs = {
            execFile: sinon.stub(),
            fs: {
                existsSync: sinon.stub().returns(true),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                readFileSync: sinon.stub()
            },
            db: {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            }
        }

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (typeof opts === 'function') { cb = opts; opts = {} }
            if (args && args.includes('build')) {
                cb(null)
            } else if (args && args.includes('run')) {
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        const ms = proxyquire('../../src/services/ModuleService', {
            'child_process': { execFile: stubs.execFile },
            'util': { promisify: () => async (cmd, args) => ({ stdout: '', stderr: '' }) },
            'fs': stubs.fs,
            '../state': {
                db: stubs.db,
                getRemoteModuleVersions: () => ({}),
                getLastStatus: () => null
            },
            './ConfigService': {
                getModuleDir: (mod) => '/modules/' + mod,
                getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon.stub().returns(false),
                checkIfModuleExists: sinon.stub().returns(true),
                removeModuleDir: sinon.stub(),
                removeModuleTmpDir: sinon.stub(),
                createModuleTmpDir: sinon.stub(),
                getDockerContainerImageName: (mod, coin, net) => 'xchain-node-' + coin + '-' + net + '-' + mod,
                getDockerNetwork: () => 'xchain-node-bitcoin-mainnet',
                getDefaultConfig: sinon.stub().resolves(envVars),
                validatePort: (v) => { const p = Number(v); return Number.isInteger(p) && p >= 1 && p <= 65535 }
            },
            './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
            './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
            './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
        })

        return ms
    }

    it('succeeds with valid port pair', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 3003 })
        const result = await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(result).to.equal('a'.repeat(64))
    })

    it('rejects when ENCODER_PORT is negative', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': -1, 'ENCODER_API_PORT': 3003 })
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Invalid port')
        }
    })

    it('rejects when ENCODER_PORT is above 65535', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': 70000, 'ENCODER_API_PORT': 3003 })
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Invalid port')
        }
    })

    it('rejects when port contains shell injection', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': '3003; rm -rf /', 'ENCODER_API_PORT': 3003 })
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Invalid port')
        }
    })

    it('rejects when ENCODER_API_PORT is NaN', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 'NaN' })
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Invalid port')
        }
    })

    it('rejects when port is zero', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': 0, 'ENCODER_API_PORT': 3003 })
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Invalid port')
        }
    })

    it('rejects when port is a float', async function () {
        const ms = loadModuleService({ 'ENCODER_PORT': 3.14, 'ENCODER_API_PORT': 3003 })
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Invalid port')
        }
    })

    it('succeeds with no port mapping (module without port config)', async function () {
        // If no ENCODER_PORT/ENCODER_API_PORT keys exist, no portLine is built
        const ms = loadModuleService({ 'NETWORK': 'bitcoin-mainnet' })
        const result = await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(result).to.equal('a'.repeat(64))
    })
})
