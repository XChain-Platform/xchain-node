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
const argumentsModule = require('../../../src/services/config_service/arguments')

const dependencies = {
    Coin: { BITCOIN: 'bitcoin', LITECOIN: 'litecoin' },
    Network: { MAINNET: 'mainnet', REGTEST: 'regtest' },
    XChainService: { XCHAIN_INDEXER: 'xchain-indexer', XCHAIN_ENCODER: 'xchain-encoder' },
    NODE_MODULE_NAME: 'node',
    DB_MODULE_NAME: 'database',
    HUB_MODULE_NAME: 'xchain-hub',
    EXPLORER_MODULE_NAME: 'xchain-explorer',
    SYNC_MODULE_NAME: 'xchain-sync',
    releaseManifestService: { isReleaseRef: ref => /^v\d/.test(ref || '') },
    serviceAliases: () => ({ hub: 'xchain-hub', indexer: 'xchain-indexer' })
}

describe('config_service/arguments', function () {
    beforeEach(function () {
        argumentsModule.configure(dependencies)
    })

    after(function () {
        delete require.cache[require.resolve('../../../src/services/config_service')]
        require('../../../src/services/config_service')
    })

    it('returns all selectors when no arguments are supplied', function () {
        expect(argumentsModule.resolveArgs([])).to.deep.equal({
            service: 'all', chain: 'all', network: 'all', branch: null, isRelease: false
        })
    })

    it('classifies service aliases, coins, networks, and a release ref', function () {
        expect(argumentsModule.resolveArgs(['hub', 'bitcoin', 'regtest', 'v1.2.3'], { expectBranch: true }))
            .to.deep.equal({
                service: 'xchain-hub', chain: 'bitcoin', network: 'regtest',
                branch: 'v1.2.3', isRelease: true
            })
    })

    it('uses the requested default branch when a ref is expected', function () {
        expect(argumentsModule.resolveArgs(['xchain-indexer'], {
            expectBranch: true,
            defaultBranch: 'develop'
        })).to.include({ branch: 'develop', isRelease: false })
    })

    it('rejects the CLI package name instead of expanding it to all services', function () {
        expect(() => argumentsModule.resolveArgs(['xchain-node']))
            .to.throw("'xchain-node' is the CLI itself")
    })

    it('rejects unknown selectors and unsafe branch names', function () {
        expect(() => argumentsModule.resolveArgs(['mystery']))
            .to.throw("Unrecognized argument 'mystery'")
        expect(() => argumentsModule.resolveArgs(['feature;rm'], { expectBranch: true }))
            .to.throw('Invalid branch name')
    })
})
