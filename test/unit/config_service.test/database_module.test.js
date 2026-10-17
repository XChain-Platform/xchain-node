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
const sinon = require('sinon')
const databaseModule = require('../../../src/services/config_service/database')

const INDEXER = 'xchain-indexer'

function configure({ persistedHubPass, generated = 'a'.repeat(48) } = {}) {
    const sidecars = {
        hubSidecarPath: sinon.stub().returns('/config/hub.local'),
        readSidecarValue: sinon.stub().resolves(persistedHubPass),
        upsertSidecarValues: sinon.stub()
    }
    const crypto = {
        randomBytes: sinon.stub().returns({ toString: sinon.stub().withArgs('hex').returns(generated) })
    }
    databaseModule.configure({ crypto, XChainService: { XCHAIN_INDEXER: INDEXER }, sidecars })
    return { crypto, sidecars }
}

describe('config_service/database credential generation', function () {
    it('reuses a persisted hub password without generating a replacement', async function () {
        const { crypto, sidecars } = configure({ persistedHubPass: 'persisted-pass' })

        expect(await databaseModule.getOrCreateHubDbPass()).to.equal('persisted-pass')
        expect(crypto.randomBytes.called).to.equal(false)
        expect(sidecars.upsertSidecarValues.called).to.equal(false)
    })

    it('generates and persists a missing hub password', async function () {
        const { sidecars } = configure({ generated: 'b'.repeat(48) })

        expect(await databaseModule.getOrCreateHubDbPass()).to.equal('b'.repeat(48))
        expect(sidecars.upsertSidecarValues.calledOnceWithExactly(
            '/config/hub.local', { HUB_DB_PASS: 'b'.repeat(48) }
        )).to.equal(true)
    })

    it('generates only missing module credentials and persists them together', function () {
        const { sidecars } = configure()
        const config = { DECODER_DB_PASS: 'operator-pass' }

        databaseModule.generateDatabaseCredentials(config, '/config/bitcoin-mainnet.local')

        expect(config).to.deep.equal({ DECODER_DB_PASS: 'operator-pass', INDEXER_DB_PASS: 'a'.repeat(48) })
        expect(sidecars.upsertSidecarValues.calledOnceWithExactly(
            '/config/bitcoin-mainnet.local', { INDEXER_DB_PASS: 'a'.repeat(48) }
        )).to.equal(true)
    })
})

describe('config_service/database config shaping', function () {
    it('uses the indexer password for hub access and fails if it is absent', function () {
        configure()
        const config = { INDEXER_DB_PASS: 'indexer-pass' }

        databaseModule.setIndexerHubPassword(config, {}, INDEXER)
        expect(config.HUB_DB_PASS).to.equal('indexer-pass')
        expect(() => databaseModule.setIndexerHubPassword({}, {}, INDEXER))
            .to.throw('INDEXER_DB_PASS was not generated')
    })

    it('merges defaults while suppressing a single hub URL when seeds are configured', function () {
        configure()
        const config = { HUB_SEED_URLS: 'https://one.test,https://two.test' }

        databaseModule.mergeDefaults(config, { HUB_API_URL: 'https://managed.test', HUB_PORT: 10000 })

        expect(config).to.deep.equal({
            HUB_SEED_URLS: 'https://one.test,https://two.test',
            HUB_PORT: 10000
        })
    })

    it('rewrites only database host and port keys already present', function () {
        configure()
        const config = { DECODER_DB_HOST: 'mariadb', DATABASE_PORT: 3306, OTHER: 'keep' }

        databaseModule.applyExternalDatabase(config, { host: '172.18.0.1', port: 3307 })

        expect(config).to.deep.equal({ DECODER_DB_HOST: '172.18.0.1', DATABASE_PORT: 3307, OTHER: 'keep' })
    })
})

after(function () {
    delete require.cache[require.resolve('../../../src/services/config_service')]
    require('../../../src/services/config_service')
})
