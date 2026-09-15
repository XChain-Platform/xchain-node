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
    // SEC-020: Branch name validation
    describe('Branch name validation', function () {

        it('cloneGit rejects branch names with shell metacharacters', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master;rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('cloneGit rejects branch names with backticks', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master`whoami`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('cloneGit rejects branch names with $() command substitution', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, '$(whoami)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })
    })
})

describe('Security', function () {
    describe('Branch name validation', function () {
        it('cloneGit accepts valid branch names', async function () {
            const stubs = { execFile: makeExecFileStub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, 'feature/my-branch_v1.0')
            // One CLONE. Counting every execFile call would drift with the
            // source-identity reads that follow a clone, which are not clones.
            const clones = stubs.execFile.getCalls().filter(c => c.args[1][0] === 'clone')
            expect(clones.length).to.equal(1)
            const [, args] = clones[0].args
            expect(args).to.include('-b')
            expect(args).to.include('feature/my-branch_v1.0')
        })

        it('resolveArgs rejects invalid branch names', function () {
            const ConfigService = require('../../../src/services/config_service')
            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'bad;branch'], { expectBranch: true })
            }).to.throw('Invalid branch name')
        })

        it('resolveArgs accepts valid branch names', function () {
            const ConfigService = require('../../../src/services/config_service')
            const result = ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'develop'], { expectBranch: true })
            expect(result.branch).to.equal('develop')
        })
    })
})
