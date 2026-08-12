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
const TestEnv = require('../../integration/helpers/test-env')
const { filterCommandParameters } = require('../../../src/services/ConfigService')

describe('E2E: Update Flow (Scenario 4.6)', function () {
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

    describe('E2E-040: Update replaces container', function () {

        it('kills old container, removes it, builds new image, and runs new container', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const oldContainerId = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(oldContainerId).to.not.be.null

            env.capture.reset()

            await cli.moduleOps.updateModules(serviceList)

            const killCmds = env.capture.findCommands(/docker kill/)
            expect(killCmds.length).to.be.greaterThanOrEqual(1)
            const killHasOldId = killCmds.some(c => c.command.includes(oldContainerId))
            expect(killHasOldId, 'kill references old container').to.be.true

            const rmCmds = env.capture.findCommands(/docker rm/)
            expect(rmCmds.length).to.be.greaterThanOrEqual(1)

            env.capture.assertCalled(/docker build/)

            env.capture.assertCalled(/docker run/)
        })
    })

    describe('E2E-041: LevelDB updated with new container ID', function () {

        it('new container ID is stored after update', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const oldContainerId = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')

            await cli.moduleOps.updateModules(serviceList)

            const newContainerId = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(newContainerId).to.not.be.null
            expect(newContainerId).to.have.lengthOf(64)
            expect(newContainerId).to.not.equal(oldContainerId)
        })
    })

    describe('E2E-042: Update with specific branch', function () {

        it('git clone uses the specified branch', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            env.capture.reset()

            await cli.moduleOps.updateModules(serviceList, 'develop')

            const cloneCmds = env.capture.findCommands(/git clone/)
            expect(cloneCmds.length).to.be.greaterThanOrEqual(1)
            const hasDevelop = cloneCmds.some(c => c.command.includes('-b develop'))
            expect(hasDevelop, 'git clone uses develop branch').to.be.true
        })
    })

    describe('E2E-043: Update multiple modules', function () {

        it('updates each module independently', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const oldEncoderId = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            const oldDecoderId = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')

            await cli.moduleOps.updateModules(serviceList)

            const newEncoderId = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            const newDecoderId = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')

            expect(newEncoderId).to.not.equal(oldEncoderId)
            expect(newDecoderId).to.not.equal(oldDecoderId)
        })
    })
})
