'use strict'

// The hub is handed the offer-list arm; a regtest indexer is handed the
// exact-integer wire-field arm; shared-ledger indexers never see either.

const { expect, makeServiceWithConfig } = require('../config_service.test/helpers.test')

const OFFER = 'XC_OFFER_LIST_REGTEST_ACTIVATION'
const WIRE = 'EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME'
const VALUES = { [OFFER]: '20', [WIRE]: '1700000000' }

describe('regtest gate switch passthrough', function () {
    let saved

    beforeEach(function () {
        saved = {}
        for (const name of Object.keys(VALUES)) { saved[name] = process.env[name]; process.env[name] = VALUES[name] }
    })

    afterEach(function () {
        for (const name of Object.keys(VALUES)) {
            if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]
        }
    })

    it('hands the hub the offer-list arm', async function () {
        const hub = await makeServiceWithConfig('').getDefaultConfig('xchain-hub', null, null)
        expect(hub[OFFER]).to.equal(VALUES[OFFER])
    })

    it('hands a regtest indexer the wire-field arm', async function () {
        const indexer = await makeServiceWithConfig('').getDefaultConfig('xchain-indexer', 'dogecoin', 'regtest')
        expect(indexer[WIRE]).to.equal(VALUES[WIRE])
    })

    it('never hands a shared-ledger indexer the wire-field arm', async function () {
        const cs = makeServiceWithConfig('')
        for (const net of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', net)
            expect(config, net).to.not.have.property(WIRE)
        }
    })
})
