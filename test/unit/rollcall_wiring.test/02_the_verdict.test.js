'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The ROLLCALL wiring guard's verdict: the refusal and what it says, the
// deploys it leaves alone, and the override that turns it into a warning.

const sinon      = require('sinon')
const { expect } = require('chai')

const {
    assertDogeReadWired, describeUnwiredDogeRead, describeWhereToPoint,
    NO_DOGE_READ_OVERRIDE_ENV, NO_DOGE_READ_ERROR_CODE, PUBLIC_DOGE_READ_URL
} = require('../../../src/services/rollcall_wiring')

const INDEXER = 'xchain-indexer'
const HUB     = 'xchain-hub'

// Handed in as the config home so the shell running the suite never leaks
// its own override into a verdict.
const noOverride = { env: {} }
const overridden = { env: { [NO_DOGE_READ_OVERRIDE_ENV]: '1' } }

let warnStub

function refusal(module, coin, network, env, deps = noOverride) {
    try { assertDogeReadWired(module, coin, network, env, deps) } catch (e) { return e }
    return null
}

describe('ROLLCALL wiring guard: the refusal', function () {

    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => { warnStub.restore() })

    it('REFUSES a BTC testnet indexer with no DOGE read, naming the variable, the wedge block and the hub', () => {
        const err = refusal(INDEXER, 'bitcoin', 'testnet', { INDEXER_COIN: 'BTC' })
        expect(err).to.be.an('error')
        expect(err.code).to.equal(NO_DOGE_READ_ERROR_CODE)
        expect(err.message).to.match(/^REFUSING to deploy/)
        expect(err.message).to.contain('DOGE_INDEXER_API_URL')
        expect(err.message).to.contain('DOGE_INDEXER_URL')
        expect(err.message).to.contain('epoch + 144 + 36')
        expect(err.message).to.contain('151200')
        expect(err.message).to.match(/hub in validator mode needs the same URL/)
        expect(err.message).to.contain(NO_DOGE_READ_OVERRIDE_ENV)
        expect(warnStub.called).to.equal(false)
    })

    it('names the public explorer read for testnet, with no key, and the self-hosted alternative', () => {
        const message = refusal(INDEXER, 'bitcoin', 'testnet', {}).message
        expect(message).to.contain('DOGE_INDEXER_API_URL=https://explorer.xchain.io/TDOGE/api/')
        expect(message).to.match(/with no DOGE_INDEXER_API_KEY/)
        expect(message).to.not.match(/federation read key/)
        expect(message).to.match(/running its own dogecoin testnet indexer points at that instead/)
        expect(message).to.not.contain('/DOGE/api/')
    })

    it('REFUSES a BTC mainnet indexer too: mainnet is armed from genesis, and names the mainnet explorer read', () => {
        const message = refusal(INDEXER, 'bitcoin', 'mainnet', {}).message
        expect(message).to.contain('epochs from BTC height 0')
        expect(message).to.contain('DOGE_INDEXER_API_URL=https://explorer.xchain.io/DOGE/api/')
        expect(message).to.not.contain('TDOGE')
    })

    it('a regtest refusal names no public URL', () => {
        const message = refusal(INDEXER, 'bitcoin', 'regtest', { XC_ROLLCALL_REGTEST_ACTIVATION: 'armed' }).message
        expect(message).to.not.contain('explorer.xchain.io')
        expect(message).to.match(/to a reachable dogecoin regtest indexer/)
        expect(describeWhereToPoint('regtest')).to.not.contain('https://')
        expect(PUBLIC_DOGE_READ_URL).to.deep.equal({ mainnet: 'https://explorer.xchain.io/DOGE/api/', testnet: 'https://explorer.xchain.io/TDOGE/api/' })
    })

    it('REFUSES a validator hub on testnet with no DOGE read', () => {
        const err = refusal(HUB, null, null, { P2P_VALIDATOR_ADDR: 'hub.example:10002', HUB_NETWORK: 'testnet' })
        expect(err.message).to.contain('validator mode, HUB_NETWORK=testnet')
    })

    it('REFUSES a BTC regtest indexer once the venue arms, with the regtest formula', () => {
        const err = refusal(INDEXER, 'bitcoin', 'regtest', { XC_ROLLCALL_REGTEST_ACTIVATION: 'armed' })
        expect(err.message).to.contain('epoch + 12 + 2')
    })

    it('the message names the target both ways', () => {
        expect(describeUnwiredDogeRead(INDEXER, 'bitcoin', 'testnet', 151200)).to.match(/^ROLLCALL wiring \(xchain-indexer bitcoin\/testnet\)/)
        expect(describeUnwiredDogeRead(HUB, null, 'mainnet', 0)).to.match(/^ROLLCALL wiring \(xchain-hub \(validator mode, HUB_NETWORK=mainnet\)\)/)
    })
})

describe('ROLLCALL wiring guard: the deploys it leaves alone', function () {

    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => { warnStub.restore() })

    it('a BTC testnet indexer whose env carries the URL, in either spelling', () => {
        expect(assertDogeReadWired(INDEXER, 'bitcoin', 'testnet', { DOGE_INDEXER_API_URL: 'http://doge:3004' }, noOverride)).to.equal(null)
        expect(assertDogeReadWired(INDEXER, 'bitcoin', 'testnet', { DOGE_INDEXER_URL: 'http://doge:3004' }, noOverride)).to.equal(null)
    })

    it('an LTC or DOGE indexer with nothing set', () => {
        expect(assertDogeReadWired(INDEXER, 'litecoin', 'testnet', {}, noOverride)).to.equal(null)
        expect(assertDogeReadWired(INDEXER, 'dogecoin', 'testnet', {}, noOverride)).to.equal(null)
    })

    it('a BTC regtest indexer while the venue is inert', () => {
        expect(assertDogeReadWired(INDEXER, 'bitcoin', 'regtest', {}, noOverride)).to.equal(null)
        expect(assertDogeReadWired(INDEXER, 'bitcoin', 'regtest', { XC_ROLLCALL_REGTEST_ACTIVATION: 'off' }, noOverride)).to.equal(null)
    })

    it('a standalone hub, and a validator hub that is wired', () => {
        const validator = { P2P_VALIDATOR_ADDR: 'hub.example:10002', HUB_NETWORK: 'testnet' }
        expect(assertDogeReadWired(HUB, null, null, { HUB_NETWORK: 'testnet' }, noOverride)).to.equal(null)
        expect(assertDogeReadWired(HUB, null, null, { ...validator, DOGE_INDEXER_URL: 'http://doge:3004' }, noOverride)).to.equal(null)
        expect(warnStub.called).to.equal(false)
    })
})

describe('ROLLCALL wiring guard: the override', function () {

    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => { warnStub.restore() })

    it('downgrades the refusal to one warning carrying the same text', () => {
        const verdict = assertDogeReadWired(INDEXER, 'bitcoin', 'testnet', {}, overridden)
        expect(verdict).to.deep.equal({ network: 'testnet', armedHeight: 151200, overridden: true })
        expect(warnStub.calledOnce).to.equal(true)
        expect(warnStub.firstCall.args[0]).to.match(/^WARNING: ROLLCALL wiring \(xchain-indexer bitcoin\/testnet\)/)
        expect(warnStub.firstCall.args[0]).to.contain('epoch + 144 + 36')
        expect(warnStub.firstCall.args[0]).to.contain('DOGE_INDEXER_API_URL=https://explorer.xchain.io/TDOGE/api/')
        expect(warnStub.firstCall.args[0]).to.contain(NO_DOGE_READ_OVERRIDE_ENV + ' is set; deploying anyway')
    })

    it('spelled 0 or false is not an override', () => {
        expect(refusal(INDEXER, 'bitcoin', 'testnet', {}, { env: { [NO_DOGE_READ_OVERRIDE_ENV]: '0' } })).to.be.an('error')
        expect(refusal(INDEXER, 'bitcoin', 'testnet', {}, { env: { [NO_DOGE_READ_OVERRIDE_ENV]: 'false' } })).to.be.an('error')
        expect(warnStub.called).to.equal(false)
    })
})
