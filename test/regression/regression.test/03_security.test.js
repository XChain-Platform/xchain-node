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

const { loadDockerService, loadModuleService } = require('./support/helpers')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Security', function () {

        it('R-SEC-001: branch name with shell metacharacters rejected', async function () {
            const stubs = { execFile: sinon.stub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master;rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('R-SEC-002: branch name with backticks and $() rejected', async function () {
            const stubs = { execFile: sinon.stub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master`whoami`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }

            try {
                await ms.cloneGit('xchain-encoder', false, false, '$(whoami)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('R-SEC-003: container ID with non-hex characters rejected', async function () {
            const stubs = { execFile: sinon.stub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
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

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Security', function () {

        it('R-SEC-004: container ID with injection payload rejected', async function () {
            const stubs = { execFile: sinon.stub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
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

        it('R-SEC-005: DockerService uses execFile (no shell) for all commands', async function () {
            const stubs = { execFile: sinon.stub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            await ds.startContainer('abc123')
            expect(stubs.execFile.calledOnce).to.be.true
            const [cmd, args] = stubs.execFile.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.be.an('array')
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Security', function () {

        it('R-SEC-006: shell metacharacters in env values pass literally via the child env, never argv', async function () {
            const stubs = { execFile: sinon.stub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            let runArgs = null
            let runOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'run') {
                    runArgs = args
                    runOpts = typeof rest[0] === 'object' ? rest[0] : null
                    cb(null, 'a'.repeat(64) + '\n')
                }
                else cb(null, '')
            })
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'DANGEROUS': 'value$(whoami)',
                    'BACKTICK': 'hello`cmd`world'
                })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            // execFile + env-channel: metacharacters are never shell-evaluated
            // AND never appear in argv (secret-leak hardening).
            expect(runArgs).to.include('--env')
            expect(runArgs).to.include('DANGEROUS')
            expect(runArgs).to.include('BACKTICK')
            expect(runArgs.join(' ')).to.not.include('value$(whoami)')
            expect(runOpts.env['DANGEROUS']).to.equal('value$(whoami)')
            expect(runOpts.env['BACKTICK']).to.equal('hello`cmd`world')
        })

        it('R-SEC-007: NODE_PREFIX regex rejects shell metacharacters', function () {
            const constants = require('../../../src/config/index')
            expect(constants.NODE_PREFIX).to.match(/^[a-z0-9][a-z0-9._-]*$/)
        })
    })
})
