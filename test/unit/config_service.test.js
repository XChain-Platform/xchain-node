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
    sinon, configStub, expect, path, NODE_PREFIX,
    SEP, DB_SEP, NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, Coin, Network, XChainService,
    CoinTickerSymbol, REGTEST_MODULES, moduleDir, tmpDir, cryptoNodesDir,
    dataDir, configDir, NO_VALIDATOR, makeConfigService, streamFromString,
    makeServiceWithConfig, makeMemoryConfigService, CONTAINER_ID, coinSidecar, coinMain,
    hubSidecar
} = require('./config_service.test/helpers.test')
const proxyquire = require('proxyquire').noCallThru()

function configServiceBasics1() {
    const { getModuleDir } = require('../../src/services/config_service')

    it('returns moduleDir + / + module', function () {
        expect(getModuleDir('xchain-encoder')).to.equal(moduleDir + '/xchain-encoder')
    })

}

function configServiceBasics2() {
    const { getModuleTmpDir } = require('../../src/services/config_service')

    it('returns tmpDir + / + module', function () {
        expect(getModuleTmpDir('xchain-decoder')).to.equal(tmpDir + '/xchain-decoder')
    })

}

function configServiceBasics3() {
    const { getCryptoNodeDir } = require('../../src/services/config_service')

    it('returns correct path for bitcoin (string value)', function () {
        expect(getCryptoNodeDir('bitcoin')).to.equal(cryptoNodesDir + '/bitcoin')
    })

    it('returns correct path for BITCOIN (enum key)', function () {
        expect(getCryptoNodeDir('BITCOIN')).to.equal(cryptoNodesDir + '/bitcoin')
    })

    it('returns correct path for dogecoin', function () {
        expect(getCryptoNodeDir('dogecoin')).to.equal(cryptoNodesDir + '/dogecoin')
    })

    it('returns correct path for litecoin', function () {
        expect(getCryptoNodeDir('litecoin')).to.equal(cryptoNodesDir + '/litecoin')
    })

}

function configServiceBasics4() {
    it('returns false for non-existent module', function () {
        const fsStub = { existsSync: sinon.stub().returns(false) }
        const cs = makeConfigService(fsStub)
        expect(cs.moduleDirExists('xchain-fake')).to.be.false
    })

    it('returns true when directory exists', function () {
        const fsStub = { existsSync: sinon.stub().returns(true) }
        const cs = makeConfigService(fsStub)
        expect(cs.moduleDirExists('xchain-encoder')).to.be.true
    })

}

function configServiceBasics5() {
    it('returns true when dir, Dockerfile, src, and package.json all exist', function () {
        const fsStub = { existsSync: sinon.stub().returns(true) }
        const cs = makeConfigService(fsStub)
        expect(cs.checkIfModuleExists('xchain-encoder')).to.be.true
        expect(fsStub.existsSync.callCount).to.equal(4)
    })

    it('returns false when Dockerfile is missing', function () {
        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => !p.endsWith('/Dockerfile'))
        }
        const cs = makeConfigService(fsStub)
        expect(cs.checkIfModuleExists('xchain-encoder')).to.be.false
    })

    it('returns false when src directory is missing', function () {
        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => !p.endsWith('/src'))
        }
        const cs = makeConfigService(fsStub)
        expect(cs.checkIfModuleExists('xchain-encoder')).to.be.false
    })

    it('returns false when package.json is missing', function () {
        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => !p.endsWith('/package.json'))
        }
        const cs = makeConfigService(fsStub)
        expect(cs.checkIfModuleExists('xchain-encoder')).to.be.false
    })

}

function configServiceBasics6() {
    it('returns true when dir, Dockerfile, and src exist', function () {
        const fsStub = { existsSync: sinon.stub().returns(true) }
        const cs = makeConfigService(fsStub)
        expect(cs.checkIfCryptoNodeSourceExists('bitcoin')).to.be.true
    })

    it('returns false when Dockerfile missing', function () {
        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => !p.endsWith('/Dockerfile'))
        }
        const cs = makeConfigService(fsStub)
        expect(cs.checkIfCryptoNodeSourceExists('bitcoin')).to.be.false
    })

}

function configServiceBasics7() {
    const { getDockerContainerImageName } = require('../../src/services/config_service')

    it('builds coin-specific image name: xchain-node-bitcoin-mainnet-xchain-encoder', function () {
        const name = getDockerContainerImageName('xchain-encoder', 'bitcoin', 'mainnet')
        expect(name).to.equal('xchain-node-bitcoin-mainnet-xchain-encoder')
    })

    it('builds shared module name without coin/network: xchain-node-xchain-hub', function () {
        const name = getDockerContainerImageName(HUB_MODULE_NAME, '', '')
        expect(name).to.equal('xchain-node-xchain-hub')
    })

    it('builds database name: xchain-node-database', function () {
        const name = getDockerContainerImageName(DB_MODULE_NAME, 'bitcoin', 'mainnet')
        expect(name).to.equal('xchain-node-database')
    })

    it('builds explorer name: xchain-node-xchain-explorer', function () {
        const name = getDockerContainerImageName(EXPLORER_MODULE_NAME, '', '')
        expect(name).to.equal('xchain-node-xchain-explorer')
    })

    it('builds sync name: xchain-node-xchain-sync', function () {
        const name = getDockerContainerImageName(SYNC_MODULE_NAME, '', '')
        expect(name).to.equal('xchain-node-xchain-sync')
    })

    it('builds correct names for all coin/network combos', function () {
        for (const coin of Object.values(Coin)) {
            for (const network of Object.values(Network)) {
                const name = getDockerContainerImageName('xchain-encoder', coin, network)
                expect(name).to.equal(`xchain-node-${coin}-${network}-xchain-encoder`)
            }
        }
    })

}

// Regression coverage for uuid:7523dd94 / uuid:a61fc673: this helper is
// the single source of truth for the tracker volume name, consumed by
// ModuleService.buildAndUp, moduleOperations.resetModules, and all three
// BootstrapService sites so they can no longer drift from each other.
function configServiceBasics8() {
    const { getUtxoTrackerVolumeName } = require('../../src/services/config_service')

    it('keeps the legacy unprefixed name under the default NODE_PREFIX', function () {
        expect(getUtxoTrackerVolumeName('bitcoin', 'mainnet')).to.equal('xchain-utxo-tracker-bitcoin-mainnet-data')
    })

    it('prefixes the name under a non-default NODE_PREFIX', function () {
        const stubbedConstants = configStub({ NODE_PREFIX: 'xchain-fed' })
        const { getUtxoTrackerVolumeName: getName } = proxyquire('../../src/services/config_service', {
            '../config/index': stubbedConstants
        })
        expect(getName('bitcoin', 'regtest')).to.equal('xchain-fed-xchain-utxo-tracker-bitcoin-regtest-data')
    })

}

function configServiceBasics9() {
    const { getDockerNetwork } = require('../../src/services/config_service')

    it('returns xchain-node-bitcoin-mainnet for bitcoin mainnet', function () {
        expect(getDockerNetwork('bitcoin', 'mainnet')).to.equal('xchain-node-bitcoin-mainnet')
    })

    it('returns xchain-node for empty coin and network', function () {
        expect(getDockerNetwork('', '')).to.equal('xchain-node')
    })

    it('handles only coin without network', function () {
        expect(getDockerNetwork('bitcoin', '')).to.equal('xchain-node-bitcoin')
    })

}

function configServiceBasics10() {
    const { getModuleDatabaseName } = require('../../src/services/config_service')

    it('returns XChain_BTC_Mainnet_Decoder for bitcoin mainnet decoder', function () {
        expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal('XChain_BTC_Mainnet_Decoder')
    })

    it('returns XChain_DOGE_Testnet_Indexer for dogecoin testnet indexer', function () {
        expect(getModuleDatabaseName('xchain-indexer', 'dogecoin', 'testnet'))
            .to.equal('XChain_DOGE_Testnet_Indexer')
    })

    it('returns XChain_LTC_Regtest_Decoder for litecoin regtest decoder', function () {
        expect(getModuleDatabaseName('xchain-decoder', 'litecoin', 'regtest'))
            .to.equal('XChain_LTC_Regtest_Decoder')
    })

    it('capitalizes module name correctly (utxo-tracker -> Utxo-tracker)', function () {
        const name = getModuleDatabaseName('xchain-utxo-tracker', 'bitcoin', 'mainnet')
        expect(name).to.equal('XChain_BTC_Mainnet_Utxo-tracker')
    })

    it('uses correct ticker for all coins', function () {
        expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.include('BTC')
        expect(getModuleDatabaseName('xchain-decoder', 'dogecoin', 'mainnet')).to.include('DOGE')
        expect(getModuleDatabaseName('xchain-decoder', 'litecoin', 'mainnet')).to.include('LTC')
    })

    it('throws on an unknown network (e.g. a typo from a raw CLI arg)', function () {
        expect(() => getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainet')).to.throw(/Unknown network/)
    })

    it('allows the shared-service empty-string network', function () {
        expect(() => getModuleDatabaseName('xchain-hub', '', '')).to.not.throw()
    })

}

function configServiceBasics11() {
    const os = require('os')
    const fs = require('fs')
    const { persistSidecarCreds } = require('../../src/services/config_service')

    let tmpFile

    beforeEach(function () {
        tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-sidecar-')), 'bitcoin-mainnet.local')
    })

    afterEach(function () {
        try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }) } catch {}
    })

    it('inserts a separating newline when appending to a file not ending in one (#2406)', function () {
        fs.writeFileSync(tmpFile, 'EXISTING=1')
        persistSidecarCreds(tmpFile, { NEW: '2' })
        expect(fs.readFileSync(tmpFile, 'utf8')).to.equal('EXISTING=1\nNEW=2\n')
    })

    it('does not add a blank line when the existing file already ends in a newline', function () {
        fs.writeFileSync(tmpFile, 'EXISTING=1\n')
        persistSidecarCreds(tmpFile, { NEW: '2' })
        expect(fs.readFileSync(tmpFile, 'utf8')).to.equal('EXISTING=1\nNEW=2\n')
    })

    it('does not prepend a newline when creating a fresh file', function () {
        persistSidecarCreds(tmpFile, { NEW: '2' })
        expect(fs.readFileSync(tmpFile, 'utf8')).to.equal('NEW=2\n')
    })

}

describe('ConfigService', function () {
    describe('getModuleDir()', configServiceBasics1)
})

describe('ConfigService', function () {
    describe('getModuleTmpDir()', configServiceBasics2)
})

describe('ConfigService', function () {
    describe('getCryptoNodeDir()', configServiceBasics3)
})

describe('ConfigService', function () {
    describe('moduleDirExists()', configServiceBasics4)
})

describe('ConfigService', function () {
    describe('checkIfModuleExists()', configServiceBasics5)
})

describe('ConfigService', function () {
    describe('checkIfCryptoNodeSourceExists()', configServiceBasics6)
})

describe('ConfigService', function () {
    describe('getDockerContainerImageName()', configServiceBasics7)
})

describe('ConfigService', function () {
    describe('getUtxoTrackerVolumeName()', configServiceBasics8)
})

describe('ConfigService', function () {
    describe('getDockerNetwork()', configServiceBasics9)
})

describe('ConfigService', function () {
    describe('getModuleDatabaseName()', configServiceBasics10)
})

describe('ConfigService', function () {
    describe('persistSidecarCreds()', configServiceBasics11)
})

require('./config_service.test/get_default_config_regtest.test')
require('./config_service.test/with_coin_and_network.test')
require('./config_service.test/database_credentials.test')
require('./config_service.test/service_routes.test')
require('./config_service.test/sidecar_and_bootstrap.test')
require('./config_service.test/rollcall_and_mirror.test')
require('./config_service.test/encoder_and_leveldb.test')
require('./config_service.test/shared_service_config.test')
require('./config_service.test/shared_service_guards.test')
require('./config_service.test/ensure_hub_api_key.test')
require('./config_service.test/filter_command_parameters.test')
require('./config_service.test/resolve_args.test')
