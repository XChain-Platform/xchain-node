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

    // Experiment: validatePort chaos
    describe('Experiment: Port validation under chaos', function () {

        it('rejects port 0', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(0)).to.be.false
        })

        it('rejects negative ports', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(-1)).to.be.false
        })

        it('rejects ports above 65535', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(70000)).to.be.false
        })

        it('rejects NaN', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(NaN)).to.be.false
        })

        it('rejects non-numeric strings', function () {
            const cs = makeConfigService()
            expect(cs.validatePort('abc')).to.be.false
        })

        it('rejects float values', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(3.14)).to.be.false
        })

        it('rejects Infinity', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(Infinity)).to.be.false
        })

        it('rejects null/undefined/objects', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(null)).to.be.false
            expect(cs.validatePort(undefined)).to.be.false
            expect(cs.validatePort({})).to.be.false
            expect(cs.validatePort([])).to.be.false
        })
    })
})
