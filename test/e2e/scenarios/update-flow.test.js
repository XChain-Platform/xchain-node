'use strict'

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

    // -------------------------------------------------------------------
    // E2E-040: Update kills old container and creates new one
    // -------------------------------------------------------------------

    describe('E2E-040: Update replaces container', function () {

        it('kills old container, removes it, builds new image, and runs new container', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            // Install first
            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const oldContainerId = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(oldContainerId).to.not.be.null

            env.capture.reset()

            // Update
            await cli.moduleOps.updateModules(serviceList)

            // Should have killed the old container
            const killCmds = env.capture.findCommands(/docker kill/)
            expect(killCmds.length).to.be.greaterThanOrEqual(1)
            const killHasOldId = killCmds.some(c => c.command.includes(oldContainerId))
            expect(killHasOldId, 'kill references old container').to.be.true

            // Should have removed the old container
            const rmCmds = env.capture.findCommands(/docker rm/)
            expect(rmCmds.length).to.be.greaterThanOrEqual(1)

            // Should have built a new image
            env.capture.assertCalled(/docker build/)

            // Should have run a new container
            env.capture.assertCalled(/docker run/)
        })
    })

    // -------------------------------------------------------------------
    // E2E-041: New container ID replaces old in LevelDB
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // E2E-042: Update with branch argument
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // E2E-043: Update multiple modules in sequence
    // -------------------------------------------------------------------

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

            // Both should have new IDs
            expect(newEncoderId).to.not.equal(oldEncoderId)
            expect(newDecoderId).to.not.equal(oldDecoderId)
        })
    })
})
