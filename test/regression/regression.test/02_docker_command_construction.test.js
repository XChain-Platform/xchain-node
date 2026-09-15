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

    describe('[regression:p0] Docker Command Construction', function () {

        it('R-DCK-001: buildAndUp constructs docker run with env vars and returns 64-char container ID', async function () {
            const stubs = { execFile: sinon.stub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            const validId = 'a'.repeat(64)
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else if (args[0] === 'run') { runArgs = args; cb(null, validId + '\n') }
                else cb(null, '')
            })
            const ms = loadModuleService(stubs)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal(validId)
            expect(runArgs).to.include('-d')
            expect(runArgs[0]).to.equal('run')
        })

        it('R-DCK-002: createDockerNetwork constructs correct network create command', async function () {
            const stubs = { execFile: sinon.stub() }
            // First call: network inspect fails (network doesn't exist)
            // Second call: network create succeeds
            stubs.execFile.onFirstCall().callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            stubs.execFile.onSecondCall().callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'network-id\n')
            })
            const ds = loadDockerService(stubs)
            await ds.createDockerNetwork('xchain-node-bitcoin-mainnet')
            const [cmd, args] = stubs.execFile.secondCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.include('network')
            expect(args).to.include('create')
            expect(args).to.include('xchain-node-bitcoin-mainnet')
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Docker Command Construction', function () {

        it('R-DCK-004: env vars from config reach docker run via --env NAME + process env, never argv values', async function () {
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
                    'MY_KEY': 'my_value',
                    'ANOTHER': '42'
                })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

            // Values must NOT appear in argv (secret-leak hardening: argv is
            // world-readable via /proc/<pid>/cmdline). The name travels as a
            // bare `--env NAME`; the value rides the child's environment.
            expect(runArgs).to.include('--env')
            expect(runArgs).to.include('MY_KEY')
            expect(runArgs).to.include('ANOTHER')
            expect(runArgs).to.not.include('MY_KEY=my_value')
            expect(runArgs).to.not.include('ANOTHER=42')
            expect(runOpts, 'docker run must receive an options.env').to.be.an('object')
            expect(runOpts.env['MY_KEY']).to.equal('my_value')
            expect(runOpts.env['ANOTHER']).to.equal('42')
        })

        it('R-DCK-005: checkDockerInstalledAndReachable rejects when Docker missing', async function () {
            const stubs = { execFile: sinon.stub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('docker --version')
            }
        })
    })
})
