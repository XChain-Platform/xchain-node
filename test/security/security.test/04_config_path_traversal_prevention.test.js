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

describe('Security', function () {
    // SEC-019: Path traversal prevention
    describe('Config path traversal prevention', function () {

        it('getDefaultConfig rejects a path-traversal coin parameter', async function () {
            const ConfigService = require('../../../src/services/config_service')
            // A traversal string in `coin` must be refused. The guard is a known-coin
            // allowlist (coin-name resolution rejects an unknown coin before it can reach
            // any path join), so '../../../etc' is refused as an unknown coin; an explicit
            // 'Config path traversal detected' guard also exists on other paths. Either way
            // the malicious input must be rejected, not silently accepted.
            let threw = null
            try {
                await ConfigService.getDefaultConfig('xchain-encoder', '../../../etc', 'passwd')
            } catch (err) {
                threw = err
            }
            expect(threw, 'a traversal coin parameter must be rejected').to.not.equal(null)
            expect(threw.message).to.match(/traversal|unknown coin|invalid/i)
        })
    })
})
