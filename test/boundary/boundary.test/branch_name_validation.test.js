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

// 5. Branch name validation (Fix 4)
describeBoundaryTests('ModuleService: branch name validation', function () {
    it('accepts valid branch names: master', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            expect(args).to.include('-b')
            expect(args).to.include('master')
            cb(null, '', '')
        })

        await ms.cloneGit('xchain-encoder', true, false, 'master')
    })

    it('accepts valid branch names: feature/my-branch', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            expect(args).to.include('-b')
            expect(args).to.include('feature/my-branch')
            cb(null, '', '')
        })

        await ms.cloneGit('xchain-encoder', true, false, 'feature/my-branch')
    })

    it('accepts valid branch names: v1.0.0', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            expect(args).to.include('-b')
            expect(args).to.include('v1.0.0')
            cb(null, '', '')
        })

        await ms.cloneGit('xchain-encoder', true, false, 'v1.0.0')
    })
})
describeBoundaryTests('ModuleService: branch name validation', function () {
    it('accepts valid branch names: release_2.0', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            expect(args).to.include('-b')
            expect(args).to.include('release_2.0')
            cb(null, '', '')
        })

        await ms.cloneGit('xchain-encoder', true, false, 'release_2.0')
    })

    it('rejects branch name with semicolon (shell injection)', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        try {
            await ms.cloneGit('xchain-encoder', true, false, '; rm -rf /')
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include('Invalid branch name')
        }
    })

    it('rejects branch name with $() (command substitution)', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        try {
            await ms.cloneGit('xchain-encoder', true, false, '$(whoami)')
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include('Invalid branch name')
        }
    })

    it('rejects branch name with backticks', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        try {
            await ms.cloneGit('xchain-encoder', true, false, '`id`')
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include('Invalid branch name')
        }
    })
})

describeBoundaryTests('ModuleService: branch name validation', function () {
    it('rejects branch name with spaces', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        try {
            await ms.cloneGit('xchain-encoder', true, false, 'my branch')
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include('Invalid branch name')
        }
    })

    it('rejects branch name with pipe', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        try {
            await ms.cloneGit('xchain-encoder', true, false, 'foo|bar')
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include('Invalid branch name')
        }
    })

    it('allows null branch (no -b flag)', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            expect(args).to.not.include('-b')
            cb(null, '', '')
        })

        await ms.cloneGit('xchain-encoder', true, false, null)
    })

    it('rejects module with unknown git URL', async function () {
        const stubs = makeModuleServiceStubs()
        const ms = loadModuleService(stubs)

        try {
            await ms.cloneGit('nonexistent-module', true, false, 'master')
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include("doesn't have an url")
        }
    })
})
