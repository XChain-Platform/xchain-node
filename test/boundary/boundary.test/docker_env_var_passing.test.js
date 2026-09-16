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
const { moduleDir, tmpDir } = require('../../../src/config')

// Helpers
function makeModuleServiceStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            setModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves('old-container-id'),
            deleteModuleContainer: sinon.stub().resolves('removed-id')
        },
        statusChanged: sinon.stub().resolves(),
        getStatus: sinon.stub().resolves({}),
        killContainer: sinon.stub().resolves(true),
        removeContainer: sinon.stub().resolves(true)
    }
}

function loadModuleService(stubs, configOverrides) {
    const configServiceStub = Object.assign({
        getModuleDir: (m) => moduleDir + '/' + m,
        getModuleTmpDir: (m) => tmpDir + '/' + m,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (m, c, n) => `xchain-node-${c}-${n}-${m}`,
        getDockerNetwork: (c, n) => `xchain-node-${c}-${n}`,
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'bitcoin-mainnet',
            'DECODER_PORT': 3002,
            'DECODER_API_PORT': 3002
        })
    }, configOverrides || {})

    return proxyquire('../../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getLastStatus: () => null,
            getRemoteModuleVersions: () => ({})
        },
        './config_service': configServiceStub,
        './status_service': {
            statusChanged: stubs.statusChanged,
            getStatus: stubs.getStatus
        },
        './docker_service': {
            killContainer: stubs.killContainer,
            removeContainer: stubs.removeContainer
        },
        './database_service': {
            setDatabaseParameters: sinon.stub().resolves()
        }
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

// 4. Docker env var escaping (Fix 3)
describeBoundaryTests('ModuleService: Docker env var passing (execFile)', function () {
    it('passes double quotes in environment variable values unescaped', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs, {
            getDefaultConfig: sinon.stub().resolves({
                'TEST_VAR': 'hello"world'
            })
        })

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            let opts = {}, cb
            if (typeof rest[0] === 'function') { cb = rest[0] }
            else { opts = rest[0] || {}; cb = rest[1] }
            if (args[0] === 'build') {
                cb(null, '')
            } else if (args[0] === 'run') {
                expect(args).to.include('TEST_VAR=hello"world')
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
    })

    it('passes dollar signs in environment variable values unescaped', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs, {
            getDefaultConfig: sinon.stub().resolves({
                'PRICE': 'costs_$100'
            })
        })

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            let opts = {}, cb
            if (typeof rest[0] === 'function') { cb = rest[0] }
            else { opts = rest[0] || {}; cb = rest[1] }
            if (args[0] === 'build') {
                cb(null, '')
            } else if (args[0] === 'run') {
                expect(args).to.include('PRICE=costs_$100')
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
    })
})
describeBoundaryTests('ModuleService: Docker env var passing (execFile)', function () {
    it('passes backticks in environment variable values unescaped', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs, {
            getDefaultConfig: sinon.stub().resolves({
                'CMD': 'run `whoami`'
            })
        })

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            let opts = {}, cb
            if (typeof rest[0] === 'function') { cb = rest[0] }
            else { opts = rest[0] || {}; cb = rest[1] }
            if (args[0] === 'build') {
                cb(null, '')
            } else if (args[0] === 'run') {
                expect(args).to.include('CMD=run `whoami`')
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
    })

    it('passes backslashes in environment variable values unescaped', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs, {
            getDefaultConfig: sinon.stub().resolves({
                'PATH_VAR': 'C:\\Users\\test'
            })
        })

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            let opts = {}, cb
            if (typeof rest[0] === 'function') { cb = rest[0] }
            else { opts = rest[0] || {}; cb = rest[1] }
            if (args[0] === 'build') {
                cb(null, '')
            } else if (args[0] === 'run') {
                expect(args).to.include('PATH_VAR=C:\\Users\\test')
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
    })
})

describeBoundaryTests('ModuleService: Docker env var passing (execFile)', function () {
    it('handles numeric values without error', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs, {
            getDefaultConfig: sinon.stub().resolves({
                'PORT': 3002
            })
        })

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            let opts = {}, cb
            if (typeof rest[0] === 'function') { cb = rest[0] }
            else { opts = rest[0] || {}; cb = rest[1] }
            if (args[0] === 'build') {
                cb(null, '')
            } else if (args[0] === 'run') {
                expect(args).to.include('PORT=3002')
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
    })

    it('handles boolean false values', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs, {
            getDefaultConfig: sinon.stub().resolves({
                'EXPLORER_API_USER': false
            })
        })

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            let opts = {}, cb
            if (typeof rest[0] === 'function') { cb = rest[0] }
            else { opts = rest[0] || {}; cb = rest[1] }
            if (args[0] === 'build') {
                cb(null, '')
            } else if (args[0] === 'run') {
                expect(args).to.include('EXPLORER_API_USER=false')
                cb(null, 'a'.repeat(64) + '\n')
            }
        })

        await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
    })
})
