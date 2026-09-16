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
const { resolveArgs } = require('../../../src/services/config_service')

function describeBoundaryTests(title, defineTests) {
    describe('Boundary Tests', function () {
        afterEach(function () {
            sinon.restore()
        })

        describe(title, defineTests)
    })
}

// 2. resolveArgs boundaries
describeBoundaryTests('ConfigService: resolveArgs boundaries', function () {
    it('returns all defaults when all args are null', function () {
        const result = resolveArgs([null, null, null, null])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
        expect(result.branch).to.be.null
    })

    it('returns all defaults when all args are undefined', function () {
        const result = resolveArgs([undefined, undefined])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    it('returns all defaults when all args are "all"', function () {
        const result = resolveArgs(['all', 'all', 'all'])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    it('classifies args correctly regardless of order', function () {
        const result = resolveArgs(['regtest', 'xchain-encoder', 'bitcoin'])
        expect(result.service).to.equal('xchain-encoder')
        expect(result.chain).to.equal('bitcoin')
        expect(result.network).to.equal('regtest')
    })

    it('treats unrecognized arg as branch when expectBranch is true', function () {
        const result = resolveArgs(['develop', 'xchain-encoder', 'bitcoin', 'mainnet'], { expectBranch: true })
        expect(result.branch).to.equal('develop')
        expect(result.service).to.equal('xchain-encoder')
    })

    it('uses defaultBranch when no branch found and expectBranch is true', function () {
        const result = resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet'], { expectBranch: true })
        expect(result.branch).to.equal('master')
    })

    it('uses custom defaultBranch when specified', function () {
        const result = resolveArgs(['xchain-encoder'], { expectBranch: true, defaultBranch: 'develop' })
        expect(result.branch).to.equal('develop')
    })
})
describeBoundaryTests('ConfigService: resolveArgs boundaries', function () {
    it('does not set branch when expectBranch is false', function () {
        const result = resolveArgs(['unknownarg', 'bitcoin', 'mainnet'], { expectBranch: false })
        expect(result.branch).to.be.null
    })

    it('only takes the first unrecognized arg as branch', function () {
        const result = resolveArgs(['mybranch', 'otherbranch', 'bitcoin'], { expectBranch: true })
        expect(result.branch).to.equal('mybranch')
        // 'otherbranch' is silently ignored
    })

    it('handles empty args array', function () {
        const result = resolveArgs([])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    it('recognizes "node" as a service', function () {
        const result = resolveArgs(['node', 'bitcoin', 'mainnet'])
        expect(result.service).to.equal('node')
    })

    it('recognizes "database" as a service', function () {
        const result = resolveArgs(['database', 'bitcoin', 'mainnet'])
        expect(result.service).to.equal('database')
    })

    it('recognizes "explorer" as a service', function () {
        const result = resolveArgs(['explorer'])
        expect(result.service).to.equal('explorer')
    })
})
