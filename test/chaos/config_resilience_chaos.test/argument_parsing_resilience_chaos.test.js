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
const proxyquire = require('proxyquire').noCallThru()

// Helpers
function makeConfigService(fsStub, readlineOverride) {
    const constants = require('../../../src/config/index')
    const stubs = {
        'fs': fsStub || require('fs'),
        '../config/constants': {
            ...constants,
            configDir: '/test/config'
        },
        '../utils/helpers': { stringToCoin: (s) => s }
    }
    if (readlineOverride) {
        stubs['readline'] = readlineOverride
    }
    return proxyquire('../../../src/services/config_service', stubs)
}

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment: resolveArgs chaos (ARG-01 through ARG-06)
    describe('Experiment: Argument parsing resilience', function () {

        it('handles empty args array', function () {
            const cs = makeConfigService()
            const result = cs.resolveArgs([])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('handles null/undefined args in array', function () {
            const cs = makeConfigService()
            const result = cs.resolveArgs([null, undefined, ''])
            expect(result.service).to.equal('all')
        })

        it('rejects branch name with shell injection characters', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['$(whoami)'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })
    })
})

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment: Argument parsing resilience', function () {

        it('rejects branch name with semicolons', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['master; rm -rf /'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with backticks', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['`whoami`'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with spaces', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['branch with spaces'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })
    })
})

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment: Argument parsing resilience', function () {

        it('accepts valid branch names with dots, hyphens, underscores, slashes', function () {
            const cs = makeConfigService()
            const result = cs.resolveArgs(['feature/my-branch_v1.0'], { expectBranch: true })
            expect(result.branch).to.equal('feature/my-branch_v1.0')
        })

        it('handles extremely long argument strings without crashing', function () {
            const cs = makeConfigService()
            const longArg = 'a'.repeat(10000)
            // Should not throw or hang; just treated as unknown arg
            const result = cs.resolveArgs([longArg])
            expect(result.service).to.equal('all')
        })
    })
})
