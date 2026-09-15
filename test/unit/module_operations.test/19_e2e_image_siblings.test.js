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

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks, requireFromUnit } = require('./helpers/harness')



// The e2e image stages its siblings from LIBRARY_BUNDLES, and the suites reach
// them at ../../../xchain-<name>. A sibling that is required but not staged does
// not redden: the suite that needs it SKIPS, which is indistinguishable from
// green in the tally. consensusHashConformance is the one that matters most,
// being the only place sync's BlockHasher meets the indexer's committed hashes
// over real stack data, and it skipped silently until sync was added here.
describe('constants: the e2e image stages every sibling its suites require', function () {

    const { LIBRARY_BUNDLES } = requireFromUnit('../../src/config')

    it('bundles sync, so the consensus hash drift-lock can run instead of skipping', function () {
        expect(LIBRARY_BUNDLES['xchain-e2e-test']).to.include('xchain-sync')
    })

    it('keeps the siblings the other suites resolve directly', function () {
        for (const lib of ['xchain-hub', 'xchain-sdk', 'xchain-contracts', 'xchain-indexer']) {
            expect(LIBRARY_BUNDLES['xchain-e2e-test']).to.include(lib)
        }
    })
})
