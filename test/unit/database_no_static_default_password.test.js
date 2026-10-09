'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const {
    makeMemoryConfigService, HUB_MODULE_NAME, SEP, coinSidecar, hubSidecar
} = require('./config_service.test/helpers.test')

const staticPassword = ['xchain', 'password'].join(SEP)

describe('database passwords', function () {
    it('generates and persists unique service passwords without a database container', async function () {
        const { cs, files } = makeMemoryConfigService()
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')

        expect(config.DECODER_DB_PASS).to.match(/^[0-9a-f]{48}$/)
        expect(config.INDEXER_DB_PASS).to.match(/^[0-9a-f]{48}$/)
        expect(config.HUB_DB_PASS).to.match(/^[0-9a-f]{48}$/)
        expect(config.DECODER_DB_PASS).to.not.equal(staticPassword)
        expect(config.INDEXER_DB_PASS).to.not.equal(staticPassword)
        expect(config.HUB_DB_PASS).to.not.equal(staticPassword)
        expect(new Set([
            config.DECODER_DB_PASS, config.INDEXER_DB_PASS, config.HUB_DB_PASS
        ]).size).to.equal(3)
        expect(files[coinSidecar]).to.include('DECODER_DB_SECRET=')
        expect(files[coinSidecar]).to.include('INDEXER_DB_SECRET=')
        expect(files[hubSidecar]).to.include('HUB_DB_SECRET=')
    })

    it('reuses generated passwords for later service configuration', async function () {
        const { cs } = makeMemoryConfigService()
        const first = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const second = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const hub = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')

        expect(second.DECODER_DB_PASS).to.equal(first.DECODER_DB_PASS)
        expect(second.INDEXER_DB_PASS).to.equal(first.INDEXER_DB_PASS)
        expect(hub.HUB_DB_PASS).to.equal(first.HUB_DB_PASS)
    })

    it('does not share generated passwords between fresh installs', async function () {
        const first = await makeMemoryConfigService().cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const second = await makeMemoryConfigService().cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')

        for (const key of ['DECODER_DB_PASS', 'INDEXER_DB_PASS', 'HUB_DB_PASS']) {
            expect(second[key]).to.not.equal(first[key])
        }
    })

    it('contains no static database password fallback in configuration sources', function () {
        for (const relativePath of [
            'src/services/config_service/defaults.js',
            'src/services/config_service/database.js'
        ]) {
            const source = fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8')
            expect(source, relativePath).to.not.match(/["']xchain["']\s*\+\s*SEP\s*\+\s*["']password["']/)
        }
    })
})
