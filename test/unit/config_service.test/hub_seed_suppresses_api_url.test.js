'use strict'

const { expect, makeServiceWithConfig } = require('./helpers.test')

describe('mergeDefaults hub seed selection', function () {
    const hubApiUrl = 'http://xchain-node-xchain-hub:10000'
    let savedHubSeedUrls

    beforeEach(function () {
        savedHubSeedUrls = process.env.HUB_SEED_URLS
        delete process.env.HUB_SEED_URLS
    })

    afterEach(function () {
        if (savedHubSeedUrls === undefined) delete process.env.HUB_SEED_URLS
        else process.env.HUB_SEED_URLS = savedHubSeedUrls
    })

    it('omits the default hub API URL when the per-coin config has seed URLs', async function () {
        const config = await makeServiceWithConfig('HUB_SEED_URLS=default\n')
            .getDefaultConfig('xchain-indexer', 'dogecoin', 'mainnet')

        expect(config.HUB_SEED_URLS).to.equal('default')
        expect(config).not.to.have.property('HUB_API_URL')
    })

    it('omits the hub API URL when host defaults have seed URLs', async function () {
        process.env.HUB_SEED_URLS = 'default'
        const config = await makeServiceWithConfig('HUB_API_URL=http://old-feed.example:10002\n')
            .getDefaultConfig('xchain-indexer', 'dogecoin', 'mainnet')

        expect(config.HUB_SEED_URLS).to.equal('default')
        expect(config).not.to.have.property('HUB_API_URL')
    })

    it('keeps the default hub API URL when no seed URLs are set', async function () {
        const config = await makeServiceWithConfig('')
            .getDefaultConfig('xchain-indexer', 'dogecoin', 'mainnet')

        expect(config.HUB_API_URL).to.equal(hubApiUrl)
    })

    it('keeps an explicit per-coin hub API URL when no seed URLs are set', async function () {
        const explicitUrl = 'http://feed.example:10002'
        const config = await makeServiceWithConfig('HUB_API_URL=' + explicitUrl + '\n')
            .getDefaultConfig('xchain-indexer', 'dogecoin', 'mainnet')

        expect(config.HUB_API_URL).to.equal(explicitUrl)
    })
})
