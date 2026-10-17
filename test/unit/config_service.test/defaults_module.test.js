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
const defaultsModule = require('../../../src/services/config_service/defaults')

const modules = {
    node: 'node',
    hub: 'xchain-hub',
    explorer: 'xchain-explorer',
    sync: 'xchain-sync',
    decoder: 'xchain-decoder',
    encoder: 'xchain-encoder',
    indexer: 'xchain-indexer',
    tracker: 'xchain-utxo-tracker'
}

function configure(config = {}) {
    defaultsModule.configure({
        config: {
            HUB_PORT_OVERRIDE: undefined,
            EXPLORER_PORT_ENV: {},
            ALLOW_NO_COLOCATED_HUB_DB: undefined,
            HUB_API_KEY: undefined,
            CORS_ORIGIN: undefined,
            EXPLORER_CHECKPOINT_SELF_SYNC: undefined,
            SYNC_PASSTHROUGH_ENV: {},
            HUB_PUBLIC_API_URL: undefined,
            ...config
        },
        Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
        Coin: { BITCOIN: 'bitcoin' },
        CoinTickerSymbol: { bitcoin: 'BTC' },
        XChainService: {
            XCHAIN_UTXO_TRACKER: modules.tracker,
            XCHAIN_DECODER: modules.decoder,
            XCHAIN_ENCODER: modules.encoder,
            XCHAIN_INDEXER: modules.indexer
        },
        DB_SEP: '_',
        bootstrapDir: '/bootstrap',
        NODE_MODULE_NAME: modules.node,
        HUB_MODULE_NAME: modules.hub,
        EXPLORER_MODULE_NAME: modules.explorer,
        SYNC_MODULE_NAME: modules.sync,
        getDockerContainerImageName: (module, coin, network) =>
            ['xchain-node', coin, network, module].filter(Boolean).join('-'),
        getModuleDatabaseName: (module, coin, network) => `${module}:${coin}:${network}`
    })
}

describe('config_service/defaults', function () {
    after(function () {
        delete require.cache[require.resolve('../../../src/services/config_service')]
        require('../../../src/services/config_service')
    })

    it('creates coin defaults with service addresses, ports, and database identities', function () {
        configure()

        const defaults = defaultsModule.createCoinDefaults(modules.encoder, 'bitcoin', 'testnet')

        expect(defaults).to.include({
            NETWORK: 'testnet',
            NODE_URL: 'xchain-node-bitcoin-testnet-node',
            NODE_PORT: 18332,
            DECODER_DB_NAME: 'xchain-decoder:bitcoin:testnet',
            INDEXER_DB_NAME: 'xchain-indexer:bitcoin:testnet',
            HUB_API_URL: 'http://xchain-node-xchain-hub:10000',
            EXPLORER_URL: 'xchain-node-xchain-explorer'
        })
        expect(defaults.DECODER_BOOTSTRAP_VOLUME)
            .to.equal('/bootstrap/bitcoin/testnet/xchain-encoder/bootstrap/')
    })

    it('selects the correct node RPC port for every network', function () {
        configure()

        expect(defaultsModule.createCoinDefaults(modules.encoder, 'bitcoin', 'mainnet').NODE_PORT).to.equal(8332)
        expect(defaultsModule.createCoinDefaults(modules.encoder, 'bitcoin', 'testnet').NODE_PORT).to.equal(18332)
        expect(defaultsModule.createCoinDefaults(modules.encoder, 'bitcoin', 'regtest').NODE_PORT).to.equal(18444)
    })

    it('creates shared defaults with internal service names and published ports', function () {
        configure()

        expect(defaultsModule.createSharedDefaults()).to.include({
            HUB_API_HOST: 'xchain-node-xchain-hub',
            HUB_PORT: 10000,
            EXPLORER_API_HOST: 'xchain-node-xchain-explorer',
            EXPLORER_PORT_HTTP: 18080,
            SYNC_API_HOST: 'xchain-node-xchain-sync',
            SYNC_API_PORT: 3006
        })
    })

    it('applies non-empty shared host overrides before hub-key resolution', function () {
        configure({
            HUB_PORT_OVERRIDE: '11000',
            EXPLORER_PORT_ENV: { EXPLORER_PORT_HTTP: '19080', EXPLORER_PORT_HTTPS: '', EXPLORER_PORT: undefined },
            ALLOW_NO_COLOCATED_HUB_DB: '1',
            HUB_API_KEY: 'fixture-key'
        })
        const defaults = defaultsModule.createSharedDefaults()

        defaultsModule.configureSharedBeforeHubKey(defaults)

        expect(defaults).to.include({
            HUB_PORT: '11000',
            EXPLORER_PORT_HTTP: '19080',
            EXPLORER_PORT_HTTPS: 18081,
            ALLOW_NO_COLOCATED_HUB_DB: '1',
            HUB_API_KEY: 'fixture-key'
        })
    })

    it('applies shared CORS and module-specific passthroughs after hub-key resolution', function () {
        configure({
            CORS_ORIGIN: 'https://wallet.test',
            SYNC_PASSTHROUGH_ENV: { INDEX_MAP_PARITY_CHECK: 'strict' },
            HUB_PUBLIC_API_URL: 'https://hub.test'
        })
        const syncDefaults = {}
        const hubDefaults = {}

        defaultsModule.configureSharedAfterHubKey(syncDefaults, modules.sync)
        defaultsModule.configureSharedAfterHubKey(hubDefaults, modules.hub)

        expect(syncDefaults).to.deep.equal({ CORS_ORIGIN: 'https://wallet.test', INDEX_MAP_PARITY_CHECK: 'strict' })
        expect(hubDefaults).to.deep.equal({ CORS_ORIGIN: 'https://wallet.test', HUB_PUBLIC_API_URL: 'https://hub.test' })
    })
})
