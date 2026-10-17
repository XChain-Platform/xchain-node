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
const networks = require('../../../src/services/config_service/networks')

const Coin = { BITCOIN: 'bitcoin', LITECOIN: 'litecoin', DOGECOIN: 'dogecoin' }
const Network = { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' }
const XChainService = { XCHAIN_INDEXER: 'xchain-indexer' }

function configure(overrides = {}) {
    const logger = { warn: sinon.spy(), info: sinon.spy() }
    const db = { getAllModuleContainers: sinon.stub().resolves([]) }
    const config = {
        TELEMETRY_ENABLED: true,
        TELEMETRY_RETENTION_DAYS: 30,
        TELEMETRY_IP_SALT: 'salt',
        TELEMETRY_ADMIN_KEY: 'admin',
        BTC_INDEXER_API_URL: 'http://bitcoin:3004',
        childProcessEnv: () => ({}),
        ...overrides.config
    }
    networks.configure({
        stateModule: { db },
        Coin,
        Network,
        XChainService,
        logger,
        config,
        peers: {
            validatorService: {
                getValidatorEnv: () => ({}),
                validatorModeReport: () => ({ mode: 'absent', dir: '/config/validator' })
            }
        },
        readSecretHostEnv: () => undefined,
        HUB_MODULE_NAME: 'xchain-hub',
        getDockerContainerImageName: (module, coin, network) => [module, coin, network].join('-'),
        ...overrides.dependencies
    })
    return { db, logger, config }
}

function networkResolutionTests() {
    it('composes co-located LTC and DOGE indexer URLs without replacing unrelated defaults', async function () {
        configure()
        const defaults = { KEEP: 'value' }
        await networks.composeColocatedIndexerUrls(defaults, 'testnet', [
            { coin: 'litecoin', network: 'testnet', module: 'xchain-indexer' },
            { coin: 'dogecoin', network: 'mainnet', module: 'xchain-indexer' }
        ])
        expect(defaults).to.deep.equal({
            KEEP: 'value',
            LTC_INDEXER_URL: 'http://xchain-indexer-litecoin-testnet:3004'
        })
    })

    it('derives the single registered deployment network and ignores invalid rows', async function () {
        const { db } = configure()
        db.getAllModuleContainers.resolves([
            { coin: 'bitcoin', network: 'mainnet', module: 'node' },
            { coin: 'unknown', network: 'mainnet', module: 'node' },
            null
        ])
        expect(await networks.resolveDeploymentHubNetwork()).to.equal('mainnet')
    })

    it('warns once when registered stacks span multiple networks', async function () {
        const { db, logger } = configure()
        db.getAllModuleContainers.resolves([
            { coin: 'bitcoin', network: 'mainnet', module: 'node' },
            { coin: 'litecoin', network: 'testnet', module: 'node' }
        ])
        expect(await networks.resolveDeploymentHubNetwork()).to.equal(null)
        expect(await networks.resolveDeploymentHubNetwork()).to.equal(null)
        expect(logger.warn.calledOnce).to.equal(true)
        expect(logger.warn.firstCall.args[0]).to.include('mainnet, testnet')
    })

    it('recognizes a registered bitcoin indexer only on the requested network', async function () {
        const { db } = configure()
        db.getAllModuleContainers.resolves([
            { coin: 'bitcoin', network: 'regtest', module: 'xchain-indexer' }
        ])
        expect(await networks.hasBitcoinIndexer('regtest')).to.equal(true)
        expect(await networks.hasBitcoinIndexer('mainnet')).to.equal(false)
    })
}

function hubConfigurationTests() {
    it('declares a keyless non-mainnet hub and consumes HUB_NETWORK after access checks', function () {
        const { logger } = configure()
        const defaults = { HUB_NETWORK: 'REGTEST' }
        networks.configureHubAccess(defaults)
        expect(defaults).to.deep.equal({ HUB_ALLOW_UNAUTHENTICATED: 'true' })
        expect(logger.warn.calledOnce).to.equal(true)
    })

    it('leaves a keyless mainnet hub fail-closed', function () {
        const { logger } = configure()
        const defaults = { HUB_NETWORK: 'mainnet' }
        networks.configureHubAccess(defaults)
        expect(defaults).to.deep.equal({})
        expect(logger.warn.called).to.equal(false)
    })

    it('injects validator environment and reports validator mode', function () {
        const logger = { warn: sinon.spy(), info: sinon.spy() }
        configure({
            config: { XCHAIN_NODE_HUB_SIGNER_DIR: '/host/signer' },
            dependencies: {
                logger,
                peers: {
                    validatorService: {
                        getValidatorEnv: () => ({ P2P_VALIDATOR_ADDR: '127.0.0.1:9000' }),
                        validatorModeReport: () => ({ mode: 'validator', dir: '/config/validator' })
                    }
                }
            }
        })
        const defaults = {}
        networks.configureHubValidator(defaults)
        expect(defaults).to.deep.equal({
            HUB_SIGNER_MODULE: '/XChainHub/operator-signer/signer.js',
            P2P_VALIDATOR_ADDR: '127.0.0.1:9000'
        })
        expect(logger.info.calledWithMatch('VALIDATOR mode')).to.equal(true)
    })
}

describe('config_service/networks', function () {
    networkResolutionTests()
    hubConfigurationTests()
})
