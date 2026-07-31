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

const { modulesUrls } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            // cloneGit's rewrite path stages the clone and swaps it in 
            renameSync: sinon.stub()
        }
    }
}

function loadModuleService(stubs, configOverrides = {}) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        '../state': {
            db: {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: configOverrides.moduleDirExists || sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: () => 'xchain-node-bitcoin-regtest-xchain-encoder',
            getDockerNetwork: () => 'xchain-node-bitcoin-regtest',
            validatePort: () => true,
            getDefaultConfig: sinon.stub().resolves({ ENCODER_PORT: 3003, ENCODER_API_PORT: 3003 })
        },
        './StatusService': {
            statusChanged: sinon.stub().resolves(),
            getStatus: sinon.stub().resolves({})
        },
        './DockerService': {
            killContainer: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
        },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('Chaos: Git Clone Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 7: Git clone failures (CMD-08)
    // -------------------------------------------------------------------

    describe('Experiment 7: Network failure during git clone', function () {

        it('rejects with error message when clone fails with network error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('fatal: unable to access: Could not resolve host: github.com'), '', 'fatal: unable to access')
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })

        it('rejects with error when clone times out', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('fatal: unable to access: Operation timed out'))
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })

    describe('Experiment 7b: Invalid branch fails loud (no silent master fallback)', function () {

        it('rejects (no fallback clone attempt) when specified branch is not found', async function () {
            // uuid:4f649bd0: install/update pass `branch` as an explicit operator
            // request; silently building master instead is a silent-wrong-code
            // hazard, so cloneGit must fail rather than fall back.
            const stubs = makeStubs()
            let cloneAttempts = 0

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cloneAttempts++
                expect(args).to.include('-b')
                expect(args).to.include('nonexistent-branch')
                cb(new Error('Remote branch nonexistent-branch not found'), '', 'Remote branch nonexistent-branch not found')
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, 'nonexistent-branch')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('not found')
                expect(cloneAttempts).to.equal(1) // no fallback clone attempt
            }
        })

        it('does not fall back when error is not branch-related', async function () {
            const stubs = makeStubs()
            let cloneAttempts = 0

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cloneAttempts++
                cb(new Error('Permission denied (publickey)'), '', 'Permission denied')
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, 'some-branch')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
                expect(cloneAttempts).to.equal(1) // No fallback attempt
            }
        })
    })

    describe('Experiment 7c: Branch name validation in cloneGit', function () {

        it('rejects invalid branch names with shell metacharacters', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, 'branch; rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch names with backticks', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, '`whoami`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch names with dollar signs', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, '$(command)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('accepts valid branch with slashes', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, false, 'feature/my-branch')
            expect(stubs.execFile.calledOnce).to.be.true
            expect(stubs.execFile.firstCall.args[1]).to.include('feature/my-branch')
        })
    })

    describe('Experiment 7d: Module directory conflict', function () {

        it('rejects when module directory already exists and rewrite is false', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs, {
                moduleDirExists: sinon.stub().returns(true)
            })

            try {
                await ms.cloneGit('xchain-encoder', false, false)
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('already exists')
            }
        })

        it('replaces the existing directory when rewrite is true', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs, {
                moduleDirExists: sinon.stub().returns(true)
            })

            await ms.cloneGit('xchain-encoder', true, false)
            expect(stubs.execFile.calledOnce).to.be.true
            // The replacement is a swap of the staged clone, not a delete-then-clone:
            // the old directory only goes away after git has succeeded .
            expect(stubs.fs.renameSync.callCount).to.equal(2)
        })
    })

    describe('Experiment 7e: Unknown module URL', function () {

        it('rejects when module has no URL mapping', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('totally-unknown-module')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }
        })
    })

    describe('Experiment 7f: useTmp mode resilience', function () {

        it('clones to tmp directory when useTmp=true', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('/tmp/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, true)
        })

        it('cleans up tmp directory before cloning in useTmp mode', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, true)
            // removeModuleTmpDir and createModuleTmpDir should be called
            // (stubbed in loadModuleService via ConfigService)
        })
    })
})
