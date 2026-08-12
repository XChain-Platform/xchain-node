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

            const btcEncoder = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(btcEncoder).to.not.be.null

            const ltcEncoder = await env.getModule('xchain-encoder', 'litecoin', 'regtest')
            expect(ltcEncoder).to.not.be.null

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

            expect(dbIdAfterBtc).to.equal(dbIdAfterLtc)
        })
    })

    describe('E2E-011: Uninstall bitcoin, litecoin remains', function () {

        it('bitcoin modules removed from LevelDB, litecoin modules preserved', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const btcList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(btcList, 'master')

            const ltcList = filterCommandParameters(null, 'xchain-encoder', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(ltcList, 'master')

            expect(await env.getModule('xchain-encoder', 'bitcoin', 'regtest')).to.not.be.null
            expect(await env.getModule('xchain-encoder', 'litecoin', 'regtest')).to.not.be.null

            await cli.moduleOps.uninstallModules(btcList)

            const btcEncoder = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(btcEncoder).to.be.null

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

            const dbEntry = await env.getModule('database', '', '')
            expect(dbEntry).to.not.be.null
        })
    })

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

            expect(btcRun.command).to.include('--hostname xchain-node-bitcoin-regtest-xchain-encoder')
            expect(ltcRun.command).to.include('--hostname xchain-node-litecoin-regtest-xchain-encoder')
        })
    })
})
