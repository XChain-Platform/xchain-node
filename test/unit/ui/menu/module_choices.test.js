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
const {
    NODE_MODULE_NAME,
    DB_MODULE_NAME,
    XChainService,
    Network
} = require('../../../../src/config')
const {
    expectedModules,
    buildModuleChoices
} = require('../../../../src/ui/menu/module_choices')

function installedModule(containerId, status) {
    return {
        container_id: containerId,
        status: { State: { Status: status } }
    }
}

describe('module menu choices', function () {
    describe('expectedModules', function () {
        it('excludes the E2E module on every network', function () {
            for (const network of Object.values(Network)) {
                expect(expectedModules(network)).to.not.include(XChainService.XCHAIN_E2E_TEST)
            }
        })

        it('includes the regtest miner only on regtest', function () {
            expect(expectedModules(Network.MAINNET)).to.not.include(XChainService.XCHAIN_REGTEST_MINER)
            expect(expectedModules(Network.TESTNET)).to.not.include(XChainService.XCHAIN_REGTEST_MINER)
            expect(expectedModules(Network.REGTEST)).to.include(XChainService.XCHAIN_REGTEST_MINER)
        })

        it('ends with the node and database module names on every network', function () {
            for (const network of Object.values(Network)) {
                expect(expectedModules(network).slice(-2)).to.deep.equal([
                    NODE_MODULE_NAME,
                    DB_MODULE_NAME
                ])
            }
        })
    })

    describe('buildModuleChoices', function () {
        it('offers installation and return when the coin or network is absent', function () {
            const fallbackChoices = [
                { name: 'Install the node', value: 'Install the node' },
                { name: 'Return', value: 'return' }
            ]
            const incompleteMaps = [{}, { bitcoin: {} }]

            for (const modulesStatus of incompleteMaps) {
                const result = buildModuleChoices(modulesStatus, 'bitcoin', Network.MAINNET)
                expect(result.moduleChoices).to.deep.equal(fallbackChoices)
                expect(result.actionModules).to.deep.equal({})
            }
        })

        it('colours installed modules, maps their status, and lists every missing module', function () {
            const installed = {
                [XChainService.XCHAIN_ENCODER]: installedModule('encoder-id', 'exited'),
                [XChainService.XCHAIN_DECODER]: installedModule('decoder-id', 'running')
            }
            const modulesStatus = { bitcoin: { [Network.MAINNET]: installed } }
            const result = buildModuleChoices(modulesStatus, 'bitcoin', Network.MAINNET)
            const redKey = `\x1b[31m${XChainService.XCHAIN_ENCODER} (exited)\x1b[37m`
            const greenKey = `\x1b[32m${XChainService.XCHAIN_DECODER} (running)\x1b[37m`
            const missing = expectedModules(Network.MAINNET)
                .filter(moduleName => !(moduleName in installed))

            expect(result.moduleChoices.slice(0, 2)).to.deep.equal([
                { name: redKey, value: XChainService.XCHAIN_ENCODER },
                { name: greenKey, value: XChainService.XCHAIN_DECODER }
            ])
            expect(result.actionModules[redKey]).to.deep.equal({
                value: XChainService.XCHAIN_ENCODER,
                container_id: 'encoder-id',
                status: 'exited'
            })
            expect(result.actionModules[greenKey]).to.deep.equal({
                value: XChainService.XCHAIN_DECODER,
                container_id: 'decoder-id',
                status: 'running'
            })
            expect(result.moduleChoices.slice(2, -2)).to.deep.equal(missing.map(moduleName => ({
                name: `\x1b[34m${moduleName} (missing)\x1b[37m`,
                value: moduleName
            })))
            for (const moduleName of missing) {
                const key = `\x1b[34m${moduleName} (missing)\x1b[37m`
                expect(result.actionModules[key]).to.deep.equal({ value: moduleName, status: 'missing' })
            }
            expect(result.moduleChoices.slice(-2)).to.deep.equal([
                { name: 'Uninstall all the modules', value: 'Uninstall all the modules' },
                { name: 'Return', value: 'return' }
            ])
        })

        it('places the E2E action immediately before uninstall and return on regtest', function () {
            const modulesStatus = {
                bitcoin: {
                    [Network.REGTEST]: {
                        [XChainService.XCHAIN_REGTEST_MINER]: installedModule('miner-id', 'running')
                    }
                }
            }
            const result = buildModuleChoices(modulesStatus, 'bitcoin', Network.REGTEST)

            expect(result.moduleChoices.slice(-3)).to.deep.equal([
                { name: 'Perform an E2E test', value: 'e2etest' },
                { name: 'Uninstall all the modules', value: 'Uninstall all the modules' },
                { name: 'Return', value: 'return' }
            ])
        })
    })
})
