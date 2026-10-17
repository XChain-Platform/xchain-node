'use strict'

// GENERATED
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
const services = require('../../../src/services/config_service/services')

const Network = { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' }
const XChainService = { XCHAIN_INDEXER: 'xchain-indexer', XCHAIN_E2E_TEST: 'xchain-e2e-test' }

function configure(configOverrides = {}, secretValues = {}, validatorSettings = null) {
    const config = {
        INDEXER_GENESIS_ENV: {},
        INDEXER_ROLLCALL_ENV: {},
        HUB_SYNC_GRACE_ENV: {},
        ...configOverrides
    }
    services.configure({
        config,
        peers: { validatorService: { getValidatorSettings: () => validatorSettings } },
        logger: { warn() {}, info() {} },
        readSecretHostEnv: name => secretValues[name],
        Coin: { BITCOIN: 'bitcoin' },
        Network,
        CoinTickerSymbol: { bitcoin: 'BTC' },
        XChainService,
        HUB_MODULE_NAME: 'xchain-hub',
        EXPLORER_MODULE_NAME: 'xchain-explorer',
        getDockerContainerImageName: (module, coin, network) => [module, coin, network].join('-')
    })
}

function e2eServiceTests() {
    it('configures the e2e container with public validator identity and hub access', function () {
        configure({ HUB_API_KEY: 'hub-key' }, {}, { pubkey: '02abcdef' })
        const defaults = {}
        services.configureE2e(defaults, 'xchain-e2e-test', 'bitcoin')
        expect(defaults).to.deep.equal({
            COIN: 'bitcoin',
            XCHAIN_CONTRACTS_DIR: '/XChainE2ETest/xchain-contracts',
            VALIDATOR_PUBKEY: '02abcdef',
            HUB_API_KEY: 'hub-key'
        })
    })

    it('does not alter a non-e2e service', function () {
        configure({ HUB_API_KEY: 'hub-key' }, {}, { pubkey: '02abcdef' })
        const defaults = { KEEP: 'value' }
        services.configureE2e(defaults, 'xchain-indexer', 'bitcoin')
        expect(defaults).to.deep.equal({ KEEP: 'value' })
    })
}

function indexerInputTests() {
    it('passes genesis, origin-indexer, hub, and regtest-only settings to an indexer', function () {
        configure({
            INDEXER_GENESIS_ENV: { XCHAIN_GENESIS_BLOCK: '101', GENESIS_DUMP_PATH: '' },
            INDEXER_ROLLCALL_ENV: {
                DOGE_INDEXER_API_URL: 'http://doge:3004',
                XC_ROLLCALL_REGTEST_ACTIVATION: '99'
            },
            HUB_API_KEY: 'private-key',
            HUB_FEED_API_KEY: 'feed-key',
            HUB_SEED_URLS: 'http://seed:10000'
        }, {
            LTC_INDEXER_URL: 'http://litecoin:3004',
            LTC_INDEXER_API_KEY: ''
        })
        const defaults = {}
        services.configureIndexerBeforeHubKey(defaults, 'xchain-indexer', 'regtest')
        expect(defaults).to.include({
            XCHAIN_GENESIS_BLOCK: '101',
            DOGE_INDEXER_API_URL: 'http://doge:3004',
            XC_ROLLCALL_REGTEST_ACTIVATION: '99',
            LTC_INDEXER_URL: 'http://litecoin:3004',
            HUB_API_KEY: 'private-key',
            HUB_FEED_API_KEY: 'feed-key',
            HUB_SEED_URLS: 'http://seed:10000'
        })
        expect(defaults).not.to.have.property('GENESIS_DUMP_PATH')
        expect(defaults).not.to.have.property('LTC_INDEXER_API_KEY')
    })

    it('does not pass regtest-only activation settings to mainnet', function () {
        configure({
            INDEXER_ROLLCALL_ENV: {
                DOGE_INDEXER_API_URL: 'http://doge:3004',
                XC_ROLLCALL_REGTEST_ACTIVATION: '99'
            }
        })
        const defaults = {}
        services.configureIndexerBeforeHubKey(defaults, 'xchain-indexer', 'mainnet')
        expect(defaults.DOGE_INDEXER_API_URL).to.equal('http://doge:3004')
        expect(defaults).not.to.have.property('XC_ROLLCALL_REGTEST_ACTIVATION')
    })
}

function indexerOutputTests() {
    it('configures indexer database mirroring and defaults every regtest grace to zero', function () {
        configure({ HUB_SYNC_GRACE_ENV: { HUB_SYNC_PRICE_GRACE_S: '7' } })
        const defaults = {
            HUB_API_KEY: 'private-key',
            INDEXER_DB_NAME: 'indexer_bitcoin_regtest',
            INDEXER_DB_USER: 'indexer_user'
        }
        services.configureIndexerAfterHubKey(defaults, 'xchain-indexer', 'regtest')
        expect(defaults).to.include({
            HUB_CONFIG_API_KEY: 'private-key',
            INDEXER_ALLOW_UNAUTHENTICATED: 'true',
            HUB_DB_NAME: 'indexer_bitcoin_regtest',
            HUB_DB_USER: 'indexer_user',
            HUB_DB_SYNC_ENABLED: 'true',
            HUB_SYNC_PRICE_GRACE_S: '7',
            HUB_SYNC_ORACLE_GRACE_S: '0',
            HUB_SYNC_POLICY_GRACE_S: '0'
        })
    })

    it('uses an explicit indexer key and leaves shared-network grace values untouched', function () {
        configure({ INDEXER_API_KEY: 'indexer-key' })
        const defaults = { INDEXER_DB_NAME: 'indexer', INDEXER_DB_USER: 'user' }
        services.configureIndexerAfterHubKey(defaults, 'xchain-indexer', 'mainnet')
        expect(defaults.INDEXER_API_KEY).to.equal('indexer-key')
        expect(defaults).not.to.have.property('INDEXER_ALLOW_UNAUTHENTICATED')
        expect(defaults).not.to.have.property('HUB_SYNC_PRICE_GRACE_S')
    })
}

describe('config_service/services', function () {
    e2eServiceTests()
    indexerInputTests()
    indexerOutputTests()
})
