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

    // Experiment: getDefaultConfig with no coin/network (shared modules)
    describe('Experiment: Shared module config (no coin/network)', function () {

        it('returns shared defaults when coin and network are null', async function () {
            const cs = makeConfigService()
            const config = await cs.getDefaultConfig('xchain-hub', null, null)

            expect(config).to.have.property('HUB_HOST', '127.0.0.1')
            expect(config).to.have.property('HUB_PORT', 10000)
            expect(config).to.not.have.property('DECODER_DB_HOST')
        })

        it('returns shared defaults when coin and network are empty strings', async function () {
            const cs = makeConfigService()
            const config = await cs.getDefaultConfig('xchain-explorer', '', '')

            expect(config).to.have.property('EXPLORER_HOST')
            expect(config).to.have.property('EXPLORER_PORT')
        })
    })
})
