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

const {
    expect, loadCredentialsService, makeFs
} = require('./helpers')

// XCHAIN_NODE_DB constant
describe('CredentialsService', function () {

    describe('XCHAIN_NODE_DB', function () {

        it('equals "xchain_node"', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.XCHAIN_NODE_DB).to.equal('xchain_node')
        })
    })
})
