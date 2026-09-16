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
    // SEC-021: NODE_PREFIX validation
    describe('NODE_PREFIX validation', function () {

        it('accepts valid lowercase alphanumeric prefix', function () {
            // The default "xchain-node" must pass validation
            const constants = require('../../../src/config/index')
            expect(constants.NODE_PREFIX).to.match(/^[a-z0-9][a-z0-9._-]*$/)
        })

        it('rejects prefix with shell metacharacters via env var', function () {
            const malicious = 'xchain;rm -rf /'
            const origEnv = process.env.NODE_PREFIX
            process.env.NODE_PREFIX = malicious
            try {
                // Clear require cache to re-evaluate config/index.js
                delete require.cache[require.resolve('../../../src/config/index')]
                expect(() => {
                    require('../../../src/config')
                }).to.throw('Invalid NODE_PREFIX')
            } finally {
                if (origEnv === undefined) delete process.env.NODE_PREFIX
                else process.env.NODE_PREFIX = origEnv
                delete require.cache[require.resolve('../../../src/config/index')]
            }
        })

        it('rejects prefix with spaces', function () {
            const origEnv = process.env.NODE_PREFIX
            process.env.NODE_PREFIX = 'xchain node'
            try {
                delete require.cache[require.resolve('../../../src/config/index')]
                expect(() => {
                    require('../../../src/config')
                }).to.throw('Invalid NODE_PREFIX')
            } finally {
                if (origEnv === undefined) delete process.env.NODE_PREFIX
                else process.env.NODE_PREFIX = origEnv
                delete require.cache[require.resolve('../../../src/config/index')]
            }
        })

        it('rejects prefix with dollar sign', function () {
            const origEnv = process.env.NODE_PREFIX
            process.env.NODE_PREFIX = 'xchain$HOME'
            try {
                delete require.cache[require.resolve('../../../src/config/index')]
                expect(() => {
                    require('../../../src/config')
                }).to.throw('Invalid NODE_PREFIX')
            } finally {
                if (origEnv === undefined) delete process.env.NODE_PREFIX
                else process.env.NODE_PREFIX = origEnv
                delete require.cache[require.resolve('../../../src/config/index')]
            }
        })
    })
})
