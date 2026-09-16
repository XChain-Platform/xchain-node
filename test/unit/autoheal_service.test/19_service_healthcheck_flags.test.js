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

describe('AutohealService', () => {
    describe('SERVICE_HEALTHCHECK opt-in flags', () => {
        const { SERVICE_HEALTHCHECK } = require('../../../src/services/module_service')

        it('xchain-utxo-tracker is never opted in (deliberate stable-halt design)', () => {
            expect(SERVICE_HEALTHCHECK['xchain-utxo-tracker'].autoheal).to.equal(undefined)
        })

        it('xchain-indexer is opted in', () => {
            expect(SERVICE_HEALTHCHECK['xchain-indexer'].autoheal).to.equal(true)
        })
    })
})
