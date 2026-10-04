'use strict'

const { expect } = require('chai')
const {
    buildCheckpointConfig,
    isCheckpointSelfSyncEnabled
} = require('../../src/services/hub_service/hub_module_config')

const COIN_CONFIG = {
    INDEXER_DB_HOST: 'mariadb',
    INDEXER_DB_PORT: 3306,
    INDEXER_DB_USER: 'xchain_indexer_bitcoin_regtest',
    INDEXER_DB_PASS: 'secret',
    INDEXER_DB_NAME: 'XChain_BTC_regtest',
    HUB_PORT: 10000
}

describe('HubService failover checkpoint config', function () {
    const envNames = ['HUB_API_URL', 'HUB_FEED_API_KEY', 'HUB_SEED_URLS']
    let savedEnv

    beforeEach(function () {
        savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
        for (const name of envNames) delete process.env[name]
    })

    afterEach(function () {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('writes seeds and the feed key without a pinned hub URL', function () {
        process.env.HUB_API_URL = 'http://old-hub.internal:10002'
        process.env.HUB_SEED_URLS = 'default,http://seed.internal:10002'
        process.env.HUB_FEED_API_KEY = 'feed-key-fixture'
        const config = buildCheckpointConfig(COIN_CONFIG)

        expect(config.hub_seed_urls).to.equal('default,http://seed.internal:10002')
        expect(config.hub_feed_api_key).to.equal('feed-key-fixture')
        expect(config).not.to.have.property('hub_url')
    })

    it('writes the feed key alongside a pinned endpoint when seeds are unset', function () {
        process.env.HUB_FEED_API_KEY = 'feed-key-fixture'
        const config = buildCheckpointConfig(COIN_CONFIG)

        expect(config.hub_feed_api_key).to.equal('feed-key-fixture')
        expect(config.hub_url).to.equal('http://xchain-node-xchain-hub:10000')
        expect(config).not.to.have.property('hub_seed_urls')
    })

    it('stays opted in when the explorer container remembers seed mode', async function () {
        const enabled = await isCheckpointSelfSyncEnabled({
            env: {},
            readContainerEnv: async () => ({ HUB_SEED_URLS: 'default' })
        })
        expect(enabled).to.be.true
    })
})
