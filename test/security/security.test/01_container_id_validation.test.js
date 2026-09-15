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

function makeExecFileStub() {
    return sinon.stub()
}

function loadModuleService(stubs) {
    const configServiceStub = {
        getModuleDir: (mod) => '/modules/' + mod,
        getModuleTmpDir: (mod) => '/tmp/' + mod,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (mod, coin, net) => `xchain-node-${coin}-${net}-${mod}`,
        getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'mainnet',
            'NODE_PORT': 8332,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
    }

    return proxyquire('../../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
        '../state': { db: stubs.db || { setModuleContainer: sinon.stub().resolves(true) }, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
        './config_service': configServiceStub,
        './status_service': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './docker_service': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), getStatusFromContainer: sinon.stub().resolves({}),
            getPublishedHostPorts: sinon.stub().resolves(new Map()) },
        './database_service': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('Security', function () {
    // SEC-014: Container ID validation
    describe('Container ID validation', function () {

        it('ModuleService buildAndUp validates container ID as 64-char hex', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            const validId = 'a'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, validId + '\n')
            })
            const ms = loadModuleService(stubs)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal(validId)
        })

        it('rejects non-hex container IDs', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            const invalidId = 'g'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, invalidId + '\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })
    })
})

describe('Security', function () {
    describe('Container ID validation', function () {
        it('rejects container IDs with shell metacharacters', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            const maliciousId = 'a'.repeat(63) + ';'
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, maliciousId + '\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects container IDs shorter than 64 chars', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, 'abc123\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })
    })
})
