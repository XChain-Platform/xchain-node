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
const path       = require('path')
const fs         = require('fs')

const ROOT = path.join(__dirname, '..', '..', '..')
const { configDir } = require(path.join(ROOT, 'src/config'))
const proxyquire = require('proxyquire').noCallThru()

let ConfigService

describe('S-SMOKE-006 – Config Composition', function () {

    // Reloaded with no stubs so the shared sidecar and database helpers are
    // configured with the real fs, not one an earlier suite handed them.
    before(function () {
        ConfigService = proxyquire(path.join(ROOT, 'src/services/config_service'), {})
    })

    it('getDefaultConfig returns populated config for bitcoin/mainnet', async function () {
        const config = await ConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')

        // NETWORK is computed, so it holds with or without a per-coin file.
        // NODE_EXPOSED_PORT and DUST_AMOUNT come only from that file, so they
        // are asserted only where the resolved config dir holds one.
        expect(config).to.have.property('NETWORK', 'bitcoin-mainnet')
        if (fs.existsSync(path.join(configDir, 'bitcoin-mainnet'))) {
            expect(config).to.have.property('NODE_EXPOSED_PORT')
            expect(config).to.have.property('DUST_AMOUNT')
        }

        // From computed defaults
        expect(config).to.have.property('DECODER_DB_NAME').that.includes('BTC')
        expect(config).to.have.property('DECODER_DB_HOST')
        expect(config).to.have.property('INDEXER_DB_NAME').that.includes('BTC')
        expect(config).to.have.property('INDEXER_DB_USER').that.includes('bitcoin')
        expect(config).to.have.property('HUB_PORT', 10000)
        expect(config).to.have.property('NODE_URL')
        expect(config).to.have.property('UTXO_TRACKER_URL').that.is.a('string').that.is.not.empty

        // No undefined values for critical keys
        const criticalKeys = ['NETWORK', 'DECODER_DB_NAME', 'INDEXER_DB_NAME', 'HUB_PORT', 'NODE_URL']
        for (const key of criticalKeys) {
            expect(config[key], `${key} is undefined`).to.not.be.undefined
        }
    })

    it('getDefaultConfig returns regtest-specific values for bitcoin/regtest', async function () {
        const config = await ConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')

        expect(config).to.have.property('NETWORK', 'bitcoin-regtest')
        expect(config).to.have.property('REGTEST_MINER_URL').that.is.a('string')
        expect(config).to.have.property('REGTEST_MINER_PORT')
    })

    it('getDefaultConfig returns shared-service config when coin/network are omitted', async function () {
        const config = await ConfigService.getDefaultConfig('xchain-hub', null, null)

        expect(config).to.have.property('HUB_PORT', 10000)
        expect(config).to.have.property('EXPLORER_PORT_HTTP')
        expect(config).to.have.property('SYNC_MODE')
    })
})
