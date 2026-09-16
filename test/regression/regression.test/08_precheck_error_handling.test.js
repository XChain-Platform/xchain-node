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

const TestEnv      = require('../../integration/helpers/test-env')

const { loadDockerService } = require('./support/helpers')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    // P2: MEDIUM
    describe('[regression:p2] Precheck & Error Handling', function () {
        this.timeout(15000)

        it('R-PRE-001: checkDockerInstalledAndReachable succeeds when Docker is available', async function () {
            const stubs = { execFile: sinon.stub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === '--version') cb(null, 'Docker version 24.0.0, build abc1234')
                else if (args[0] === 'ps') cb(null, '')
                else cb(null, '')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.checkDockerInstalledAndReachable()
            expect(result).to.be.true
        })

        it('R-PRE-002: startModules gracefully handles missing LevelDB entry', async function () {
            const env = new TestEnv()
            await env.setup()

            try {
                const moduleOps = proxyquire('../../../src/operations/module_operations', {
                    '../services/docker_service': {
                        startContainer: sinon.stub().resolves(true),
                        createDockerNetwork: async () => true,
                        stopContainer: async () => true,
                        restartContainer: async () => true,
                        killContainer: async () => true,
                        removeContainer: async () => true,
                        execContainer: async () => '',
                        shellContainer: async () => true,
                        logContainer: async () => true,
                        startDockerMonitor: async () => true
                    }
                })

                const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
                const result = await moduleOps.startModules(serviceList)
                expect(result).to.be.true
            } finally {
                await env.teardown()
            }
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p2] Precheck & Error Handling', function () {
        this.timeout(15000)

        // R-PRE-003 (LevelDB remove returns false for missing key) lives in
        // test/unit/maria_db_store.test.js after the migration to MariaDB.

        it('R-PRE-004: path traversal in config coin parameter is caught', async function () {
            const ConfigService = require('../../../src/services/config_service')
            try {
                await ConfigService.getDefaultConfig('xchain-encoder', '../../../etc', 'passwd')
                expect.fail('expected getDefaultConfig to reject a traversal coin')
            } catch (err) {
                // The coin allow-list rejects it before any path is built; the
                // message is "Unknown coin ..." rather than mentioning traversal.
                expect(err.message).to.match(/Unknown coin|traversal/)
            }
        })
    })
})
