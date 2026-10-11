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
const fs         = require('fs')
const os         = require('os')
const path       = require('path')

// Helpers
// getDefaultConfig writes sidecars under configDir through the real fs, so
// each experiment gets a fresh writable directory.
function makeConfigService(configDir) {
    const constants = require('../../../src/config/index')
    const stubs = {
        'fs': fs,
        '../config': {
            ...constants,
            configDir,
            EXTERNAL_DB: false
        },
        './database_service': { getDatabaseContainerId: async () => null },
        '../utils/helpers': { stringToCoin: (s) => s }
    }
    return proxyquire('../../../src/services/config_service', stubs)
}

describe('Chaos: Config Resilience', function () {
    let configDir

    beforeEach(function () {
        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-config-chaos-'))
    })

    afterEach(function () {
        sinon.restore()
        fs.rmSync(configDir, { recursive: true, force: true })
    })

    // Experiment: getDefaultConfig with no coin/network (shared modules)
    describe('Experiment: Shared module config (no coin/network)', function () {

        it('returns shared defaults when coin and network are null', async function () {
            const cs = makeConfigService(configDir)
            const config = await cs.getDefaultConfig('xchain-hub', null, null)

            expect(config).to.have.property('HUB_HOST', '0.0.0.0')
            expect(config).to.have.property('HUB_PORT', 10000)
            expect(config).to.not.have.property('DECODER_DB_HOST')
        })

        it('returns shared defaults when coin and network are empty strings', async function () {
            const cs = makeConfigService(configDir)
            const config = await cs.getDefaultConfig('xchain-explorer', '', '')

            expect(config).to.have.property('EXPLORER_HOST')
            expect(config).to.have.property('EXPLORER_PORT')
        })
    })
})
