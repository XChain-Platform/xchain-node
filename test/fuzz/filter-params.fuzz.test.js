'use strict'

const { expect } = require('chai')

const {
    Coin, Network, XChainService,
    NODE_MODULE_NAME, EXPLORER_MODULE_NAME, REGTEST_MODULES
} = require('../../src/config/constants')
const { filterCommandParameters } = require('../../src/services/ConfigService')

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

    // --- Invalid coin names ---

    const invalidCoins = [
        'ethereum',
        'BITCOIN',
        'Bitcoin',
        '',
        123,
        'bitcoin; echo pwned',
    ]

    for (const coin of invalidCoins) {
        it(`does not crash with invalid coin: ${JSON.stringify(coin)}`, function () {
            const result = filterCommandParameters(null, 'xchain-encoder', coin, 'mainnet')
            expect(result).to.be.an('object')
        })
    }

    // --- Invalid network names ---

    const invalidNetworks = [
        'devnet',
        'MAINNET',
        'Mainnet',
        '',
        'mainnet && echo pwned',
    ]

    for (const net of invalidNetworks) {
        it(`does not crash with invalid network: ${JSON.stringify(net)}`, function () {
            const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', net)
            expect(result).to.be.an('object')
        })
    }

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
