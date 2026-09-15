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


const {
    sinon, configStub, expect, proxyquire, path,
    NODE_PREFIX, SEP, DB_SEP, NODE_MODULE_NAME, DB_MODULE_NAME,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, Coin, Network,
    XChainService, CoinTickerSymbol, REGTEST_MODULES, moduleDir, tmpDir,
    cryptoNodesDir, dataDir, configDir, NO_VALIDATOR, makeConfigService,
    streamFromString, makeServiceWithConfig, makeMemoryConfigService, CONTAINER_ID, coinSidecar,
    coinMain, hubSidecar
} = require('./helpers.test')

// The e2e-test container learns which key the hub runs as from the same
// settings ValidatorService hands the hub, rather than from a hex string an
// operator remembered to paste into the coin config.
function makeServiceWithValidator(validatorSettings) {
    const fsStub = {
        createReadStream: sinon.stub().callsFake(() => streamFromString('')),
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().returns(''),
        appendFileSync: sinon.stub(),
        writeFileSync: sinon.stub(),
        rmSync: sinon.stub(),
        mkdirSync: sinon.stub()
    }
    return proxyquire('../../../src/services/config_service', {
        'fs': fsStub,
        './validator_service': {
            getValidatorSettings: () => validatorSettings,
            getValidatorEnv: () => ({}),
            validatorModeReport: () => ({
                mode: validatorSettings ? 'validator' : 'standalone',
                dir: '/tmp/test-xchain-config/validator',
                missing: []
            })
        }
    })
}

function coinConfig1() {
    it('returns NETWORK matching the network arg', async function () {
        const cs = makeServiceWithConfig('NETWORK=bitcoin-mainnet\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NETWORK']).to.equal('bitcoin-mainnet')
    })

    it('returns correct NODE_PORT for mainnet (8332)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NODE_PORT']).to.equal(8332)
    })

    it('returns correct NODE_PORT for testnet (18332)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'testnet')
        expect(config['NODE_PORT']).to.equal(18332)
    })

    it('returns correct NODE_PORT for regtest (18444)', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')
        expect(config['NODE_PORT']).to.equal(18444)
    })

    // NODE_URL must be the coin node's container name, not the bare `node`
    // network alias. The indexer joins its sibling coins' docker networks and
    // the hub joins every stack, and every coin node carries the alias `node`,
    // so from those containers `node` resolves to whichever sibling network
    // sorts first: a dogecoin stack's credentials then reach the bitcoin node
    // and get HTTP 401 (regtest measurement and a testnet operator report,
    // 2026-09-11). A container name is unique per coin/network and resolves
    // on any network both containers hold.
    it('NODE_URL is the coin-scoped node container name, distinct per coin', async function () {
        const cs = makeServiceWithConfig('')
        const doge = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'testnet')
        const btc  = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'testnet')
        expect(doge['NODE_URL']).to.equal('xchain-node-dogecoin-testnet-node')
        expect(btc['NODE_URL']).to.equal('xchain-node-bitcoin-testnet-node')
        expect(doge['NODE_URL']).to.not.equal(btc['NODE_URL'])
        expect(doge['NODE_URL']).to.not.equal(NODE_MODULE_NAME)
    })

    it('an operator NODE_URL override in the config file still wins over the default', async function () {
        const cs = makeServiceWithConfig('NODE_URL=doge-node.internal\n')
        const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'testnet')
        expect(config['NODE_URL']).to.equal('doge-node.internal')
    })
}

function coinConfig2() {
    it('generates random NODE_USER and NODE_PASSWORD when absent from config file', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['NODE_USER']).to.be.a('string').with.length.greaterThan(0)
        expect(config['NODE_USER']).to.not.equal('rpc')
        expect(config['NODE_PASSWORD']).to.be.a('string').with.length.greaterThan(0)
        expect(config['NODE_PASSWORD']).to.not.equal('rpc')
    })

    it('passes the validator pubkey to the e2e-test container when one is configured', async function () {
        const pubkey = 'ab'.repeat(32)
        const cs = makeServiceWithValidator({ enabled: true, pubkey })
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_E2E_TEST, 'bitcoin', 'regtest')
        expect(config['VALIDATOR_PUBKEY']).to.equal(pubkey)
    })

    it('never hands the e2e-test container the signing seed, only the public half', async function () {
        const cs = makeServiceWithValidator({ enabled: true, pubkey: 'ab'.repeat(32), seedHex: 'cd'.repeat(32) })
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_E2E_TEST, 'bitcoin', 'regtest')
        expect(config).to.not.have.property('SIGNING_PRIVKEY_HEX')
        expect(JSON.stringify(config)).to.not.include('cd'.repeat(32))
    })

    it('omits VALIDATOR_PUBKEY on a standalone node, so the onboarding suite skips rather than staking a key nothing runs as', async function () {
        const cs = makeServiceWithValidator(null)
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_E2E_TEST, 'bitcoin', 'regtest')
        expect(config).to.not.have.property('VALIDATOR_PUBKEY')
    })
}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', coinConfig1)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', coinConfig2)
    })
})
