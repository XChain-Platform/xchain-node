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

function moduleKey(color, moduleName, status) {
    return `\x1b[${color}m${moduleName} (${status})\x1b[37m`
}

function assertInstalledModules(result, installedModules) {
    const expectedChoices = installedModules.map(({ color, moduleName, status }) => ({
        name: moduleKey(color, moduleName, status),
        value: moduleName
    }))

    expect(result.moduleChoices.slice(0, installedModules.length)).to.deep.equal(expectedChoices)
    for (const { color, moduleName, containerId, status } of installedModules) {
        const key = moduleKey(color, moduleName, status)
        expect(result.actionModules[key]).to.deep.equal({
            value: moduleName,
            container_id: containerId,
            status
        })
    }
}

function assertMissingModules(result, installed) {
    const missing = expectedModules(Network.MAINNET)
        .filter(moduleName => !(moduleName in installed))
    const missingChoices = missing.map(moduleName => ({
        name: moduleKey(34, moduleName, 'missing'),
        value: moduleName
    }))

    expect(result.moduleChoices.slice(Object.keys(installed).length, -2)).to.deep.equal(missingChoices)
    for (const moduleName of missing) {
        const key = moduleKey(34, moduleName, 'missing')
        expect(result.actionModules[key]).to.deep.equal({ value: moduleName, status: 'missing' })
    }
}

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

describe('buildModuleChoices fallback', function () {
    it('offers installation and return when the coin or network is absent', function () {
        const fallbackChoices = [
            { name: 'Install the node', value: 'Install the node' },
            { name: 'Return', value: 'return' }
        ]

        for (const modulesStatus of [{}, { bitcoin: {} }]) {
            const result = buildModuleChoices(modulesStatus, 'bitcoin', Network.MAINNET)
            expect(result.moduleChoices).to.deep.equal(fallbackChoices)
            expect(result.actionModules).to.deep.equal({})
        }
    })
})

describe('buildModuleChoices populated status', function () {
    it('colours installed modules, maps their status, and lists every missing module', function () {
        const installed = {
            [XChainService.XCHAIN_ENCODER]: installedModule('encoder-id', 'exited'),
            [XChainService.XCHAIN_DECODER]: installedModule('decoder-id', 'running')
        }
        const installedModules = [
            { color: 31, moduleName: XChainService.XCHAIN_ENCODER, containerId: 'encoder-id', status: 'exited' },
            { color: 32, moduleName: XChainService.XCHAIN_DECODER, containerId: 'decoder-id', status: 'running' }
        ]
        const modulesStatus = { bitcoin: { [Network.MAINNET]: installed } }
        const result = buildModuleChoices(modulesStatus, 'bitcoin', Network.MAINNET)

        assertInstalledModules(result, installedModules)
        assertMissingModules(result, installed)
        expect(result.moduleChoices.slice(-2)).to.deep.equal([
            { name: 'Uninstall all the modules', value: 'Uninstall all the modules' },
            { name: 'Return', value: 'return' }
        ])
    })
})

describe('buildModuleChoices on regtest', function () {
    it('places the E2E action immediately before uninstall and return', function () {
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
