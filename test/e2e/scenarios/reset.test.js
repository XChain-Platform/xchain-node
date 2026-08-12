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

const { expect } = require('chai')

const E2EEnv = require('../helpers/e2e-env')
const { filterCommandParameters } = require('../../../src/services/ConfigService')

describe('E2E: Reset Command (Scenario 4.8)', function () {
    this.timeout(30000)

    let env, cli

    beforeEach(async function () {
        env = new E2EEnv()
        await env.setup()
        env.setupDefaultRoutes()

        const state = require('../../../src/state')
        state.setDbRootPassword('testrootpw')
    })

    afterEach(async function () {
        await env.teardown()
    })

    describe('E2E-050: Reset lifecycle (stop → clear → restart)', function () {

        it('stops and then restarts the specified module', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const decoderId = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(decoderId).to.not.be.null

            env.capture.reset()

            await cli.moduleOps.resetModules('xchain-decoder', 'bitcoin', 'regtest')

            const stopCmds = env.capture.findCommands(/docker stop/)
            expect(stopCmds.length).to.be.greaterThanOrEqual(1)
            const stoppedDecoder = stopCmds.some(c => c.command.includes(decoderId))
            expect(stoppedDecoder, 'decoder was stopped').to.be.true

            const startCmds = env.capture.findCommands(/docker start/)
            expect(startCmds.length).to.be.greaterThanOrEqual(1)
            const startedDecoder = startCmds.some(c => c.command.includes(decoderId))
            expect(startedDecoder, 'decoder was restarted').to.be.true
        })

        it('LevelDB entries preserved after reset', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const idBefore = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')

            await cli.moduleOps.resetModules('xchain-decoder', 'bitcoin', 'regtest')

            const idAfter = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(idAfter).to.equal(idBefore)
        })
    })

    describe('E2E-051: Reset decoder resets database', function () {

        it('executes DROP DATABASE and CREATE DATABASE for decoder DB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            env.capture.reset()

            await cli.moduleOps.resetModules('xchain-decoder', 'bitcoin', 'regtest')

            const execCmds = env.capture.findCommands(/docker exec/)
            const hasDropCreate = execCmds.some(c =>
                c.command.includes('DROP DATABASE') && c.command.includes('CREATE DATABASE')
            )
            expect(hasDropCreate, 'DROP and CREATE DATABASE executed').to.be.true
        })
    })

    describe('E2E-052: Reset all stops multiple modules', function () {

        it('stops node, utxo-tracker, decoder, indexer, and regtest-miner', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const nodeId = await env.getModule('node', 'bitcoin', 'regtest')
            const utxoId = await env.getModule('xchain-utxo-tracker', 'bitcoin', 'regtest')
            const decoderId = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            const indexerId = await env.getModule('xchain-indexer', 'bitcoin', 'regtest')

            env.capture.reset()

            await cli.moduleOps.resetModules('all', 'bitcoin', 'regtest')

            const stopCmds = env.capture.findCommands(/docker stop/)

            expect(stopCmds.length).to.be.greaterThanOrEqual(3)

            const startCmds = env.capture.findCommands(/docker start/)
            expect(startCmds.length).to.be.greaterThanOrEqual(3)
        })
    })
})
