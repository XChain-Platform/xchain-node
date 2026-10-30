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
    Coin, Network, XChainService,
    NODE_MODULE_NAME, EXPLORER_MODULE_NAME, REGTEST_MODULES,
    HUB_MODULE_NAME, DB_MODULE_NAME, SYNC_MODULE_NAME
} = require('../../src/config')
const { filterCommandParameters } = require('../../src/services/config_service')

describe('Fuzz: filterCommandParameters()', function () {

    // --- Invalid module names ---
    const invalidModulesString = [
        'nonexistent-service',
        '',
        123,
        'xchain-encoder; rm -rf /',
        '../../../etc/passwd',
        'ALL',              // uppercase
        'Node',             // title case
        'xchain-encoder\x00',
    ]

    for (const mod of invalidModulesString) {
        it(`does not crash with invalid module: ${JSON.stringify(mod)}`, function () {
            const result = filterCommandParameters(null, mod, 'bitcoin', 'mainnet')
            expect(result).to.be.an('object')
        })
    }

    it('throws on null module (not iterable)', function () {
        expect(() => filterCommandParameters(null, null, 'bitcoin', 'mainnet')).to.throw()
    })

    it('throws on undefined module (not iterable)', function () {
        expect(() => filterCommandParameters(null, undefined, 'bitcoin', 'mainnet')).to.throw()
    })
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- Invalid coin names ---
    const invalidCoins = [
        'ethereum',
        'BITCOIN',
        'Bitcoin',
        '',
        123,
        'bitcoin; echo pwned',
    ]

    // An empty value means "all"; any other unknown chain is refused by name rather than
    // expanded, so a typo can never act on the shared services.
    for (const coin of invalidCoins) {
        if (coin === '') {
            it('treats an empty coin as all and does not crash', function () {
                expect(filterCommandParameters(null, 'xchain-encoder', coin, 'mainnet')).to.be.an('object')
            })
            continue
        }
        it(`refuses invalid coin ${JSON.stringify(coin)} with a named error`, function () {
            expect(() => filterCommandParameters(null, 'xchain-encoder', coin, 'mainnet'))
                .to.throw(Error, 'unknown coin: ' + coin)
        })
    }
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- Invalid network names ---
    const invalidNetworks = [
        'devnet',
        'MAINNET',
        'Mainnet',
        '',
        'mainnet && echo pwned',
    ]

    for (const net of invalidNetworks) {
        if (net === '') {
            it('treats an empty network as all and does not crash', function () {
                expect(filterCommandParameters(null, 'xchain-encoder', 'bitcoin', net)).to.be.an('object')
            })
            continue
        }
        it(`refuses invalid network ${JSON.stringify(net)} with a named error`, function () {
            expect(() => filterCommandParameters(null, 'xchain-encoder', 'bitcoin', net))
                .to.throw(Error, 'unknown network: ' + net)
        })
    }
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- "all" expansion correctness ---
    it('"all" modules includes every non-e2e service plus node', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        const modules = result['bitcoin']['mainnet']
        const expectedServices = Object.values(XChainService).filter(s => s !== XChainService.XCHAIN_E2E_TEST)
        for (const svc of expectedServices) {
            if (!REGTEST_MODULES.includes(svc)) {
                expect(modules, `missing ${svc}`).to.include(svc)
            }
        }
        expect(modules).to.include(NODE_MODULE_NAME)
    })

    it('"all" coins produces exactly 3 coin entries', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'all', 'mainnet')
        const coins = Object.keys(result)
        expect(coins).to.have.length(3)
        expect(coins).to.include('bitcoin')
        expect(coins).to.include('dogecoin')
        expect(coins).to.include('litecoin')
    })

    it('"all" networks produces exactly 3 network entries per coin', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'all')
        const networks = Object.keys(result['bitcoin'])
        expect(networks).to.have.length(3)
        expect(networks).to.include('mainnet')
        expect(networks).to.include('testnet')
        expect(networks).to.include('regtest')
    })
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- Regtest module filtering ---
    it('regtest-only modules excluded from all non-regtest networks', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')
        for (const coin of Object.values(Coin)) {
            for (const network of Object.values(Network)) {
                const modules = result[coin][network]
                if (network !== 'regtest') {
                    for (const regtestMod of REGTEST_MODULES) {
                        expect(modules, `${regtestMod} should not be in ${coin}/${network}`).to.not.include(regtestMod)
                    }
                }
            }
        }
    })

    it('regtest-miner IS included for regtest network', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
        expect(result['bitcoin']['regtest']).to.include(XChainService.XCHAIN_REGTEST_MINER)
    })

    it('e2e-test is never included in "all" expansion', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')
        for (const coin of Object.values(Coin)) {
            for (const network of Object.values(Network)) {
                expect(result[coin][network]).to.not.include(XChainService.XCHAIN_E2E_TEST)
            }
        }
    })
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- Explorer special handling ---
    it('"all" modules adds explorer under empty coin/network keys', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        expect(result['']).to.exist
        expect(result['']['']).to.deep.equal([EXPLORER_MODULE_NAME])
    })

    it('"explorer" module produces only explorer entry', function () {
        const result = filterCommandParameters(null, 'explorer', 'bitcoin', 'mainnet')
        expect(result['']).to.exist
        expect(result['']['']).to.deep.equal([EXPLORER_MODULE_NAME])
        // No coin-specific entries
        expect(result).to.not.have.property('bitcoin')
    })
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- Shared-service routing (hub / explorer / db / sync) ---
    // Shared services register under a single empty coin+network key. A bare
    // `update xchain-hub` must resolve there, not fan out across real coins
    // (where it matches no container and silently no-ops).

    // --- Shared-service routing (hub / explorer / db / sync) ---
    // Shared services register under a single empty coin+network key. A bare
    // `update xchain-hub` must resolve there, not fan out across real coins
    // (where it matches no container and silently no-ops).
    for (const shared of [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, DB_MODULE_NAME, SYNC_MODULE_NAME]) {
        it(`explicitly-named shared service "${shared}" routes under empty coin/network only`, function () {
            const result = filterCommandParameters(null, shared, 'all', 'all')
            expect(result).to.deep.equal({ '': { '': [shared] } })
        })

        it(`shared service "${shared}" ignores coin/network args (always shared key)`, function () {
            const result = filterCommandParameters(null, shared, 'bitcoin', 'mainnet')
            expect(result['']['']).to.deep.equal([shared])
            expect(result).to.not.have.property('bitcoin')
        })
    }
})

describe('Fuzz: filterCommandParameters()', function () {
    // --- Combinatorial explosion check ---
    it('all x all x all produces bounded output', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')
        const coins = Object.values(Coin)
        const networks = Object.values(Network)
        let totalModuleSlots = 0
        for (const coin of coins) {
            for (const network of networks) {
                totalModuleSlots += result[coin][network].length
            }
        }
        // Explorer slot
        if (result[''] && result['']['']) {
            totalModuleSlots += result[''][''].length
        }
        // Should be bounded: 3 coins x 3 networks x ~6 modules + 1 explorer < 60
        expect(totalModuleSlots).to.be.lessThan(60)
    })
})
