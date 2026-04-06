'use strict'

const { expect } = require('chai')

const E2EEnv = require('../helpers/e2e-env')
const TestEnv = require('../../integration/helpers/test-env')
const { filterCommandParameters } = require('../../../src/services/ConfigService')

describe('E2E: Exec and Logs Commands (Scenarios 4.11, 4.12)', function () {
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
    // E2E-070: execModules reads container ID and calls docker exec
    // -------------------------------------------------------------------

    describe('E2E-070: Exec command', function () {

        it('executes command on the correct container from LevelDB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            // Install decoder
            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const decoderId = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(decoderId).to.not.be.null

            env.capture.reset()

            // Set up exec to return output
            env.capture.when(/docker exec/).returns({ stdout: '/app\nnode_modules\nsrc\npackage.json\n' })

            await cli.moduleOps.execModules(serviceList, 'ls /app')

            const execCmds = env.capture.findCommands(/docker exec/)
            expect(execCmds.length).to.be.greaterThanOrEqual(1)

            // Verify the exec uses the correct container ID
            const hasDecoderId = execCmds.some(c => c.command.includes(decoderId))
            expect(hasDecoderId, 'exec references decoder container ID').to.be.true

            // Verify the command is passed through
            const hasCommand = execCmds.some(c => c.command.includes('ls /app'))
            expect(hasCommand, 'exec includes the user command').to.be.true
        })

        it('skips exec when module has no container in LevelDB', async function () {
            env.setupDefaultRoutes()
            cli = env.createCLI()

            // No modules installed
            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            const result = await cli.moduleOps.execModules(serviceList, 'ls /app')
            expect(result).to.be.true

            const execCmds = env.capture.findCommands(/docker exec/)
            expect(execCmds).to.have.lengthOf(0)
        })
    })

    // -------------------------------------------------------------------
    // E2E-071: logModules reads container ID and calls docker logs
    // -------------------------------------------------------------------

    describe('E2E-071: Logs command', function () {

        it('calls docker logs with the correct container ID', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            // Install decoder
            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const decoderId = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')

            env.capture.reset()

            // logModules with follow=false to avoid hanging
            await cli.moduleOps.logModules(serviceList, false)

            // docker logs should be called via spawn
            const logCmds = env.capture.findCommands(/docker logs/)
            expect(logCmds.length).to.be.greaterThanOrEqual(1)

            // The spawned command should include the container ID
            const hasDecoderId = logCmds.some(c => c.command.includes(decoderId))
            expect(hasDecoderId, 'logs references decoder container ID').to.be.true
        })

        it('displays "No service was selected" when no modules match', async function () {
            env.setupDefaultRoutes()
            cli = env.createCLI()

            // No modules installed — logModules should handle gracefully
            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            const result = await cli.moduleOps.logModules(serviceList, false)
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // E2E-072: Restart calls docker restart for each module
    // -------------------------------------------------------------------

    describe('E2E-072: Restart command', function () {

        it('calls docker restart for each installed module', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modules = await env.getAllModules()
            const containerIds = modules.map(m => m.container_id)

            env.capture.reset()

            await cli.moduleOps.restartModules(serviceList)

            const restartCmds = env.capture.findCommands(/docker restart/)
            expect(restartCmds.length).to.be.greaterThanOrEqual(5)

            for (const cmd of restartCmds) {
                const restartedId = cmd.command.split(/\s+/).pop()
                expect(containerIds, `restarted ID ${restartedId} in LevelDB`).to.include(restartedId)
            }
        })
    })
})
