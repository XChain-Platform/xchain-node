'use strict'

const { expect } = require('chai')
const {
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    makeServiceWithConfig
} = require('./helpers.test')

function registerEnvCleanup() {
    const envNames = [
        'EXPLORER_CHECKPOINT_SELF_SYNC',
        'HUB_API_URL',
        'HUB_FEED_API_KEY',
        'HUB_PUBLIC_API_URL',
        'HUB_SEED_URLS'
    ]
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
}

describe('ConfigService indexer hub failover environment', function () {
    registerEnvCleanup()

    it('writes seed and feed credentials to every indexer without a pinned feed URL', async function () {
        process.env.HUB_SEED_URLS = 'default,http://seed.example:10002'
        process.env.HUB_FEED_API_KEY = 'feed-key-fixture'
        const config = await makeServiceWithConfig('').getDefaultConfig(
            'xchain-indexer', 'bitcoin', 'testnet')

        expect(config.HUB_SEED_URLS).to.equal('default,http://seed.example:10002')
        expect(config.HUB_FEED_API_KEY).to.equal('feed-key-fixture')
        expect(config).not.to.have.property('HUB_API_URL')
        expect(config.HUB_CONFIG_URL).to.equal(
            'http://' + config.HUB_API_HOST + ':' + config.HUB_PORT)
    })

    it('removes an old per-coin pinned feed URL when host seed mode is set', async function () {
        process.env.HUB_SEED_URLS = 'default'
        const config = await makeServiceWithConfig('HUB_API_URL=http://old-feed.example:10002\n')
            .getDefaultConfig('xchain-indexer', 'litecoin', 'testnet')

        expect(config.HUB_SEED_URLS).to.equal('default')
        expect(config).not.to.have.property('HUB_API_URL')
        expect(config.HUB_CONFIG_URL).to.equal('http://xchain-node-xchain-hub:10000')
    })

    it('keeps the pinned default when seed mode is unset', async function () {
        const config = await makeServiceWithConfig('').getDefaultConfig(
            'xchain-indexer', 'dogecoin', 'mainnet')

        expect(config.HUB_API_URL).to.equal('http://xchain-node-xchain-hub:10000')
        expect(config).not.to.have.property('HUB_SEED_URLS')
        expect(config).not.to.have.property('HUB_FEED_API_KEY')
    })

    it('does not write indexer-only discovery settings to sibling coin services', async function () {
        process.env.HUB_SEED_URLS = 'default'
        process.env.HUB_FEED_API_KEY = 'feed-key-fixture'
        const config = await makeServiceWithConfig('').getDefaultConfig(
            'xchain-decoder', 'bitcoin', 'testnet')

        expect(config.HUB_API_URL).to.equal('http://xchain-node-xchain-hub:10000')
        expect(config).not.to.have.property('HUB_SEED_URLS')
        expect(config).not.to.have.property('HUB_FEED_API_KEY')
    })
})

describe('ConfigService managed hub failover environment', function () {
    registerEnvCleanup()

    it('writes seed and feed credentials to a self-syncing explorer without a pinned feed URL', async function () {
        process.env.EXPLORER_CHECKPOINT_SELF_SYNC = '1'
        process.env.HUB_SEED_URLS = 'default'
        process.env.HUB_FEED_API_KEY = 'explorer-feed-key-fixture'
        const config = await makeServiceWithConfig('').getDefaultConfig(
            EXPLORER_MODULE_NAME, null, null)

        expect(config.HUB_SEED_URLS).to.equal('default')
        expect(config.HUB_FEED_API_KEY).to.equal('explorer-feed-key-fixture')
        expect(config).not.to.have.property('HUB_API_URL')
    })

    it('writes only the public API URL to a managed hub', async function () {
        process.env.HUB_FEED_API_KEY = 'hub-feed-key-fixture'
        process.env.HUB_PUBLIC_API_URL = 'https://public-hub.example'
        const service = makeServiceWithConfig('')
        const hubConfig = await service.getDefaultConfig(HUB_MODULE_NAME, null, null)
        const explorerConfig = await service.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)

        expect(hubConfig.HUB_PUBLIC_API_URL).to.equal('https://public-hub.example')
        expect(hubConfig).not.to.have.property('HUB_FEED_API_KEY')
        expect(explorerConfig).not.to.have.property('HUB_FEED_API_KEY')
        expect(explorerConfig).not.to.have.property('HUB_PUBLIC_API_URL')
    })

    it('treats empty failover environment values as unset', async function () {
        process.env.HUB_SEED_URLS = ''
        process.env.HUB_FEED_API_KEY = ''
        process.env.HUB_PUBLIC_API_URL = ''
        const service = makeServiceWithConfig('')
        const indexerConfig = await service.getDefaultConfig(
            'xchain-indexer', 'bitcoin', 'testnet')
        const hubConfig = await service.getDefaultConfig(HUB_MODULE_NAME, null, null)

        expect(indexerConfig.HUB_API_URL).to.equal('http://xchain-node-xchain-hub:10000')
        expect(indexerConfig).not.to.have.property('HUB_SEED_URLS')
        expect(indexerConfig).not.to.have.property('HUB_FEED_API_KEY')
        expect(hubConfig).not.to.have.property('HUB_PUBLIC_API_URL')
    })
})
