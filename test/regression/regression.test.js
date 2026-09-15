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

const sinon      = require('sinon')
const { expect } = require('chai')

const { filterCommandParameters } = require('../../src/services/config_service')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    // P0: CRITICAL
    describe('[regression:p0] Argument Parsing & Validation', function () {
        const ConfigService = require('../../src/services/config_service')

        it('R-ARG-001: resolveArgs identifies service, coin, network from any argument order', function () {
            const r1 = ConfigService.resolveArgs(['bitcoin', 'xchain-encoder', 'mainnet'])
            expect(r1.service).to.equal('xchain-encoder')
            expect(r1.chain).to.equal('bitcoin')
            expect(r1.network).to.equal('mainnet')

            const r2 = ConfigService.resolveArgs(['mainnet', 'bitcoin', 'xchain-encoder'])
            expect(r2.service).to.equal('xchain-encoder')
            expect(r2.chain).to.equal('bitcoin')
            expect(r2.network).to.equal('mainnet')

            const r3 = ConfigService.resolveArgs(['xchain-decoder', 'regtest', 'dogecoin'])
            expect(r3.service).to.equal('xchain-decoder')
            expect(r3.chain).to.equal('dogecoin')
            expect(r3.network).to.equal('regtest')
        })

        it('R-ARG-002: resolveArgs defaults to all/all/all when no args provided', function () {
            const result = ConfigService.resolveArgs([])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('R-ARG-003: resolveArgs rejects invalid branch names', function () {
            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'bad;branch'], { expectBranch: true })
            }).to.throw('Invalid branch name')

            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', '$(whoami)'], { expectBranch: true })
            }).to.throw('Invalid branch name')

            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'bad`cmd`'], { expectBranch: true })
            }).to.throw('Invalid branch name')
        })

        it('R-ARG-003b: resolveArgs accepts valid branch names', function () {
            const r = ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'feature/my-branch_v1.0'], { expectBranch: true })
            expect(r.branch).to.equal('feature/my-branch_v1.0')
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Argument Parsing & Validation', function () {
        const ConfigService = require('../../src/services/config_service')

        it('R-ARG-004: filterCommandParameters excludes regtest-only modules from mainnet/testnet', function () {
            const mainnet = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
            expect(mainnet['bitcoin']['mainnet']).to.not.include('xchain-regtest-miner')
            expect(mainnet['bitcoin']['mainnet']).to.not.include('xchain-e2e-test')

            const testnet = filterCommandParameters(null, 'all', 'bitcoin', 'testnet')
            expect(testnet['bitcoin']['testnet']).to.not.include('xchain-regtest-miner')
            expect(testnet['bitcoin']['testnet']).to.not.include('xchain-e2e-test')
        })

        it('R-ARG-005: filterCommandParameters includes regtest-miner for regtest', function () {
            const regtest = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            expect(regtest['bitcoin']['regtest']).to.include('xchain-regtest-miner')
            // e2e-test excluded from "all" expansion
            expect(regtest['bitcoin']['regtest']).to.not.include('xchain-e2e-test')
        })

        it('R-ARG-006: validatePort rejects invalid values', function () {
            const { validatePort } = ConfigService
            expect(validatePort(0)).to.be.false
            expect(validatePort(-1)).to.be.false
            expect(validatePort(65536)).to.be.false
            expect(validatePort(3.14)).to.be.false
            expect(validatePort('abc')).to.be.false
            expect(validatePort('3000; rm -rf /')).to.be.false
            expect(validatePort(NaN)).to.be.false
            expect(validatePort(Infinity)).to.be.false
            expect(validatePort(1)).to.be.true
            expect(validatePort(80)).to.be.true
            expect(validatePort(65535)).to.be.true
            expect(validatePort('8332')).to.be.true
        })
    })
})
