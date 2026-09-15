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


const { expect } = require('./helpers.test')

function resolveArgsServiceResolution() {
    const { resolveArgs } = require('../../../src/services/config_service')

    it('resolves the canonical shared-service names', function () {
        expect(resolveArgs(['master', 'xchain-hub'], { expectBranch: true }))
            .to.include({ service: 'xchain-hub', branch: 'master' })
    })

    it('resolves the short shared-service aliases to their canonical names', function () {
        expect(resolveArgs(['master', 'hub'],  { expectBranch: true })).to.include({ service: 'xchain-hub' })
        expect(resolveArgs(['master', 'sync'], { expectBranch: true })).to.include({ service: 'xchain-sync' })
        expect(resolveArgs(['master', 'db'],   { expectBranch: true })).to.include({ service: 'database' })
    })

    // The bug: an unrecognized token was silently dropped, leaving
    // service='all'. `install master hub` did not refuse the unknown name, it
    // installed EVERY service on every coin and network. The 'xchain-node'
    // guard already documented this trap but covered only that one name.
    it('refuses an unrecognized service name instead of expanding to every service', function () {
        expect(() => resolveArgs(['master', 'hubb'], { expectBranch: true }))
            .to.throw(/Unrecognized argument 'hubb'/)
        expect(() => resolveArgs(['master', 'xchain-indexr'], { expectBranch: true }))
            .to.throw(/Unrecognized argument/)
    })

    it('names the valid services in the refusal, so the operator can correct it', function () {
        try {
            resolveArgs(['master', 'hubb'], { expectBranch: true })
            expect.fail('should have thrown')
        } catch (err) {
            expect(err.message).to.include('xchain-hub')
            expect(err.message).to.include('xchain-indexer')
            expect(err.message).to.include('bitcoin')
            expect(err.message).to.include('testnet')
        }
    })

    it('still accepts every legitimate argument shape', function () {
        expect(resolveArgs(['master', 'xchain-indexer', 'bitcoin', 'mainnet'], { expectBranch: true }))
            .to.include({ service: 'xchain-indexer', chain: 'bitcoin', network: 'mainnet', branch: 'master' })
        expect(resolveArgs(['master', 'all'], { expectBranch: true }))
            .to.include({ service: 'all', branch: 'master' })
        expect(resolveArgs(['master', 'node', 'litecoin', 'testnet'], { expectBranch: true }))
            .to.include({ service: 'node', chain: 'litecoin', network: 'testnet' })
        expect(resolveArgs(['xchain-decoder', 'bitcoin', 'regtest'], { expectBranch: false }))
            .to.include({ service: 'xchain-decoder', chain: 'bitcoin', network: 'regtest' })
    })

    // A branch name is an arbitrary string, so the free slot must still take
    // one; the refusal only fires once that slot is spoken for.
    it('leaves the branch slot free to take an arbitrary name', function () {
        expect(resolveArgs(['feature/some-branch', 'xchain-indexer'], { expectBranch: true }))
            .to.include({ service: 'xchain-indexer', branch: 'feature/some-branch' })
    })

}

describe('ConfigService', function () {
    describe('resolveArgs() service resolution', resolveArgsServiceResolution)
})
