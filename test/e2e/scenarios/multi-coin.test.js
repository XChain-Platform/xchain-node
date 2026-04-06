'use strict'

const { expect } = require('chai')

const E2EEnv = require('../helpers/e2e-env')
const { filterCommandParameters } = require('../../../src/services/ConfigService')

describe('E2E: Multi-Coin Installation (Scenario 4.2)', function () {
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
    // E2E-010: Install two coins
    // -------------------------------------------------------------------

    describe('E2E-010: Install bitcoin/regtest + litecoin/regtest', function () {

        it('creates separate Docker networks for each coin', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const ltcList = filterCommandParameters(null, 'all', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            const networkCmds = env.capture.findCommands(/docker network inspect/)
            const networkNames = networkCmds.map(c => c.command)

            const hasBtcNetwork = networkNames.some(cmd => cmd.includes('xchain-node-bitcoin-regtest'))
            const hasLtcNetwork = networkNames.some(cmd => cmd.includes('xchain-node-litecoin-regtest'))
            expect(hasBtcNetwork, 'bitcoin network checked').to.be.true
            expect(hasLtcNetwork, 'litecoin network checked').to.be.true
        })

        it('stores separate LevelDB entries per coin', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const ltcList = filterCommandParameters(null, 'all', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            // Bitcoin modules
            const btcEncoder = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(btcEncoder).to.not.be.null

            // Litecoin modules
            const ltcEncoder = await env.getModule('xchain-encoder', 'litecoin', 'regtest')
            expect(ltcEncoder).to.not.be.null

            // They should have different container IDs
            expect(btcEncoder).to.not.equal(ltcEncoder)
        })

        it('database container is shared (single entry in LevelDB)', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const dbIdAfterBtc = await env.getModule('database', '', '')

            const ltcList = filterCommandParameters(null, 'all', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            const dbIdAfterLtc = await env.getModule('database', '', '')

            // Same database container for both coins
            expect(dbIdAfterBtc).to.equal(dbIdAfterLtc)
        })
    })

    // -------------------------------------------------------------------
    // E2E-011: Uninstall one coin, other remains
    // -------------------------------------------------------------------

    describe('E2E-011: Uninstall bitcoin, litecoin remains', function () {

        it('bitcoin modules removed from LevelDB, litecoin modules preserved', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const ltcList = filterCommandParameters(null, 'xchain-encoder', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            // Verify both exist
            expect(await env.getModule('xchain-encoder', 'bitcoin', 'regtest')).to.not.be.null
            expect(await env.getModule('xchain-encoder', 'litecoin', 'regtest')).to.not.be.null

            // Uninstall bitcoin only
            await cli.moduleOps.uninstallModules(btcList)

            // Bitcoin module should be removed
            const btcEncoder = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(btcEncoder).to.be.null

            // Litecoin module should remain
            const ltcEncoder = await env.getModule('xchain-encoder', 'litecoin', 'regtest')
            expect(ltcEncoder).to.not.be.null
        })

        it('shared services remain after partial uninstall', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const ltcList = filterCommandParameters(null, 'xchain-encoder', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            await cli.moduleOps.uninstallModules(btcList)

            // Database should remain
            const dbEntry = await env.getModule('database', '', '')
            expect(dbEntry).to.not.be.null
        })
    })

    // -------------------------------------------------------------------
    // E2E-012: Container naming per coin
    // -------------------------------------------------------------------

    describe('E2E-012: Container naming uses coin-specific prefixes', function () {

        it('docker run commands use xchain-node-<coin>-<network>-<module> naming', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const ltcList = filterCommandParameters(null, 'xchain-encoder', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            const runCmds = env.capture.findCommands(/docker run/)

            const btcRun = runCmds.find(c => c.command.includes('xchain-node-bitcoin-regtest-xchain-encoder'))
            const ltcRun = runCmds.find(c => c.command.includes('xchain-node-litecoin-regtest-xchain-encoder'))

            expect(btcRun, 'bitcoin encoder run command').to.exist
            expect(ltcRun, 'litecoin encoder run command').to.exist

            // Hostnames should differ
            expect(btcRun.command).to.include('--hostname xchain-node-bitcoin-regtest-xchain-encoder')
            expect(ltcRun.command).to.include('--hostname xchain-node-litecoin-regtest-xchain-encoder')
        })
    })
})
