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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const { Readable } = require('stream')

const {
    NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, cryptoNodesDir, dataDir, configDir
} = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Load ConfigService with stubbed fs (for getDefaultConfig's file reading)
// ---------------------------------------------------------------------------

function makeConfigService(fsStub) {
    return proxyquire('../../src/services/ConfigService', {
        'fs': fsStub || require('fs')
    })
}

// Helper: create a Readable stream from a string (simulates config file)
function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

describe('ConfigService', function () {

    // -------------------------------------------------------------------
    // Path helpers
    // -------------------------------------------------------------------

    describe('getModuleDir()', function () {
        const { getModuleDir } = require('../../src/services/ConfigService')

        it('returns moduleDir + / + module', function () {
            expect(getModuleDir('xchain-encoder')).to.equal(moduleDir + '/xchain-encoder')
        })
    })

    describe('getModuleTmpDir()', function () {
        const { getModuleTmpDir } = require('../../src/services/ConfigService')

        it('returns tmpDir + / + module', function () {
            expect(getModuleTmpDir('xchain-decoder')).to.equal(tmpDir + '/xchain-decoder')
        })
    })

    describe('getCryptoNodeDir()', function () {
        const { getCryptoNodeDir } = require('../../src/services/ConfigService')

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
    })

    describe('moduleDirExists()', function () {
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
    })

    describe('checkIfModuleExists()', function () {
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
    })

    describe('checkIfCryptoNodeSourceExists()', function () {
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
    })

    // -------------------------------------------------------------------
    // Naming helpers
    // -------------------------------------------------------------------

    describe('getDockerContainerImageName()', function () {
        const { getDockerContainerImageName } = require('../../src/services/ConfigService')

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
    })

    // Regression coverage for uuid:7523dd94 / uuid:a61fc673: this helper is
    // the single source of truth for the tracker volume name, consumed by
    // ModuleService.buildAndUp, moduleOperations.resetModules, and all three
    // BootstrapService sites so they can no longer drift from each other.
    describe('getUtxoTrackerVolumeName()', function () {
        const { getUtxoTrackerVolumeName } = require('../../src/services/ConfigService')

        it('keeps the legacy unprefixed name under the default NODE_PREFIX', function () {
            expect(getUtxoTrackerVolumeName('bitcoin', 'mainnet')).to.equal('xchain-utxo-tracker-bitcoin-mainnet-data')
        })

        it('prefixes the name under a non-default NODE_PREFIX', function () {
            const stubbedConstants = Object.assign({}, require('../../src/config/constants'), { NODE_PREFIX: 'xchain-fed' })
            const { getUtxoTrackerVolumeName: getName } = proxyquire('../../src/services/ConfigService', {
                '../config/constants': stubbedConstants
            })
            expect(getName('bitcoin', 'regtest')).to.equal('xchain-fed-xchain-utxo-tracker-bitcoin-regtest-data')
        })
    })

    describe('getDockerNetwork()', function () {
        const { getDockerNetwork } = require('../../src/services/ConfigService')

        it('returns xchain-node-bitcoin-mainnet for bitcoin mainnet', function () {
            expect(getDockerNetwork('bitcoin', 'mainnet')).to.equal('xchain-node-bitcoin-mainnet')
        })

        it('returns xchain-node for empty coin and network', function () {
            expect(getDockerNetwork('', '')).to.equal('xchain-node')
        })

        it('handles only coin without network', function () {
            expect(getDockerNetwork('bitcoin', '')).to.equal('xchain-node-bitcoin')
        })
    })

    describe('getModuleDatabaseName()', function () {
        const { getModuleDatabaseName } = require('../../src/services/ConfigService')

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
    })

    // -------------------------------------------------------------------
    // getDefaultConfig
    // -------------------------------------------------------------------

    describe('getDefaultConfig()', function () {

        // Stub fs.createReadStream to return mock config file content
        function makeServiceWithConfig(configContent) {
            const fsStub = {
                createReadStream: sinon.stub().callsFake(() => streamFromString(configContent)),
                existsSync: sinon.stub().returns(true),
                // existsSync=true routes upsertSidecarValues into fs.readFileSync on the
                // sidecar; return an empty sidecar so the merge starts from nothing.
                readFileSync: sinon.stub().returns(''),
                appendFileSync: sinon.stub(),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            return makeConfigService(fsStub)
        }

        describe('with coin and network (coin-specific config)', function () {

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

            it('generates random NODE_USER and NODE_PASSWORD when absent from config file', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['NODE_USER']).to.be.a('string').with.length.greaterThan(0)
                expect(config['NODE_USER']).to.not.equal('rpc')
                expect(config['NODE_PASSWORD']).to.be.a('string').with.length.greaterThan(0)
                expect(config['NODE_PASSWORD']).to.not.equal('rpc')
            })

            // A memory-backed fs so generate -> persist -> read-back is observable across
            // calls (the default makeServiceWithConfig stub no-ops writes). Keyed by the
            // exact paths ConfigService resolves: config/<coin>-<network>, its .local
            // sidecar, and the shared config/hub.local.
            // dbContainerId / externalDb control whether DB-password rotation is considered
            // possible (a DB container to exec into, or EXTERNAL_DB): per-install passwords are
            // only generated where they can be applied to the live account. Default is the
            // native, no-container case (rotation impossible -> static default).
            function makeMemoryConfigService(initialFiles = {}, { dbContainerId = null, externalDb = false } = {}) {
                const files = { ...initialFiles }
                const fsStub = {
                    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
                    createReadStream: (p) => streamFromString(files[p] || ''),
                    readFileSync: (p) => files[p] != null ? String(files[p]) : '',
                    writeFileSync: (p, body) => { files[p] = String(body) },
                    appendFileSync: (p, body) => { files[p] = (files[p] || '') + String(body) },
                    chmodSync: () => {},
                    mkdirSync: () => {},
                    rmSync: (p) => { delete files[p] }
                }
                const cs = proxyquire('../../src/services/ConfigService', {
                    'fs': fsStub,
                    './DatabaseService': {
                        getDatabaseContainerId: async () => dbContainerId,
                        getExternalDbConfig: async () => ({ host: '172.18.0.1', port: 3307, root_user: 'root', root_password: 'x' })
                    },
                    '../config/constants': { ...require('../../src/config/constants'), EXTERNAL_DB: externalDb }
                })
                return { cs, files }
            }
            const CONTAINER_ID = 'a'.repeat(64)
            const coinSidecar = path.resolve(configDir, 'bitcoin-mainnet') + '.local'
            const coinMain    = path.resolve(configDir, 'bitcoin-mainnet')
            const hubSidecar  = path.resolve(configDir, 'hub.local')

            it('does NOT auto-generate DB passwords where rotation cannot apply them (native/no-container -> static default)', async function () {
                // The 2026-06-26 indexer outage: a generated sidecar password the native-DB
                // rotation could never apply, desyncing config from the live account.
                const { cs, files } = makeMemoryConfigService()
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_PASS']).to.equal('xchain' + SEP + 'password')
                expect(config['INDEXER_DB_PASS']).to.equal('xchain' + SEP + 'password')
                expect(files[coinSidecar] || '').to.not.include('DECODER_DB_PASS=')
                expect(files[coinSidecar] || '').to.not.include('INDEXER_DB_PASS=')
            })

            it('generates per-install DB passwords when a DB container exists (rotation can apply them) and persists them', async function () {
                const { cs, files } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
                expect(config['INDEXER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
                expect(config['DECODER_DB_PASS']).to.not.equal('xchain' + SEP + 'password')
                expect(files[coinSidecar]).to.include('DECODER_DB_PASS=')
                expect(files[coinSidecar]).to.include('INDEXER_DB_PASS=')
            })

            it('generates per-install DB passwords under EXTERNAL_DB (native-path rotation)', async function () {
                const { cs } = makeMemoryConfigService({}, { externalDb: true })
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
                expect(config['DECODER_DB_PASS']).to.not.equal('xchain' + SEP + 'password')
            })

            it('reuses the persisted DB password on subsequent calls (stable across installs/updates)', async function () {
                const { cs } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
                const first  = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                const second = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(second['DECODER_DB_PASS']).to.equal(first['DECODER_DB_PASS'])
                expect(second['INDEXER_DB_PASS']).to.equal(first['INDEXER_DB_PASS'])
            })

            it('an operator override in the main config file wins and is not regenerated', async function () {
                const { cs } = makeMemoryConfigService({ [coinMain]: 'DECODER_DB_PASS=operatorsecret\n' }, { dbContainerId: CONTAINER_ID })
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_PASS']).to.equal('operatorsecret')
            })

            it('HUB_DB_PASS falls back to the shared static default when rotation cannot apply it', async function () {
                const { cs, files } = makeMemoryConfigService()
                const coinCfg = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                const hubCfg  = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
                expect(coinCfg['HUB_DB_PASS']).to.equal('xchain' + SEP + 'password')
                expect(hubCfg['HUB_DB_PASS']).to.equal(coinCfg['HUB_DB_PASS'])
                expect(files[hubSidecar]).to.equal(undefined)
            })

            it('HUB_DB_PASS is generated, shared, and persisted when rotation can apply it', async function () {
                const { cs, files } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
                const coinCfg = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                const hubCfg  = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
                expect(coinCfg['HUB_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
                expect(coinCfg['HUB_DB_PASS']).to.not.equal('xchain' + SEP + 'password')
                expect(hubCfg['HUB_DB_PASS']).to.equal(coinCfg['HUB_DB_PASS'])
                expect(files[hubSidecar]).to.include('HUB_DB_PASS=')
            })

            it('passes INDEXER_API_KEY through from host env to the indexer config (federation auth)', async function () {
                const prev = process.env.INDEXER_API_KEY
                process.env.INDEXER_API_KEY = 'fed-secret-123'
                try {
                    const { cs } = makeMemoryConfigService()
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
                    expect(config['INDEXER_API_KEY']).to.equal('fed-secret-123')
                } finally {
                    if (prev === undefined) delete process.env.INDEXER_API_KEY
                    else process.env.INDEXER_API_KEY = prev
                }
            })

            it('omits INDEXER_API_KEY when unset in host env (indexer stays fail-closed)', async function () {
                const prev = process.env.INDEXER_API_KEY
                delete process.env.INDEXER_API_KEY
                try {
                    const { cs } = makeMemoryConfigService()
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
                    expect(config['INDEXER_API_KEY']).to.equal(undefined)
                    // mainnet/testnet must NOT get the keyless escape hatch.
                    expect(config['INDEXER_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
                } finally {
                    if (prev !== undefined) process.env.INDEXER_API_KEY = prev
                }
            })

            it('defaults INDEXER_ALLOW_UNAUTHENTICATED=true on keyless regtest installs (gated methods usable)', async function () {
                const prev = process.env.INDEXER_API_KEY
                delete process.env.INDEXER_API_KEY
                try {
                    const { cs } = makeMemoryConfigService()
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                    expect(config['INDEXER_ALLOW_UNAUTHENTICATED']).to.equal('true')
                } finally {
                    if (prev !== undefined) process.env.INDEXER_API_KEY = prev
                }
            })

            it('keeps regtest fail-closed when a host INDEXER_API_KEY is provided', async function () {
                const prev = process.env.INDEXER_API_KEY
                process.env.INDEXER_API_KEY = 'fed-secret-123'
                try {
                    const { cs } = makeMemoryConfigService()
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                    expect(config['INDEXER_API_KEY']).to.equal('fed-secret-123')
                    expect(config['INDEXER_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
                } finally {
                    if (prev === undefined) delete process.env.INDEXER_API_KEY
                    else process.env.INDEXER_API_KEY = prev
                }
            })

            it('returns correct UTXO_TRACKER_URL as Docker image name', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['UTXO_TRACKER_URL']).to.equal('xchain-node-bitcoin-mainnet-xchain-utxo-tracker')
            })

            it('returns correct DECODER_DB_NAME', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_NAME']).to.equal('XChain_BTC_Mainnet_Decoder')
            })

            it('returns correct INDEXER_DB_NAME', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
                expect(config['INDEXER_DB_NAME']).to.equal('XChain_BTC_Mainnet_Indexer')
            })

            describe('native-coin fee destination injection', function () {
                const FEE_ENV = 'XCHAIN_FEE_DESTINATION_BTC_REGTEST'
                let savedPerCoin, savedGeneric
                beforeEach(function () {
                    savedPerCoin = process.env[FEE_ENV]
                    savedGeneric = process.env.FEE_DESTINATION
                    delete process.env[FEE_ENV]
                    delete process.env.FEE_DESTINATION
                })
                afterEach(function () {
                    if (savedPerCoin === undefined) delete process.env[FEE_ENV]; else process.env[FEE_ENV] = savedPerCoin
                    if (savedGeneric === undefined) delete process.env.FEE_DESTINATION; else process.env.FEE_DESTINATION = savedGeneric
                })

                it('injects FEE_DESTINATION (decoder) + per-coin var (indexer) from the host env', async function () {
                    process.env[FEE_ENV] = 'mFeeRegtestAddr111'
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
                    expect(config['FEE_DESTINATION']).to.equal('mFeeRegtestAddr111')
                    expect(config[FEE_ENV]).to.equal('mFeeRegtestAddr111')
                })

                it('falls back to a generic FEE_DESTINATION host env var', async function () {
                    process.env.FEE_DESTINATION = 'mGenericFeeAddr222'
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                    expect(config[FEE_ENV]).to.equal('mGenericFeeAddr222')
                })

                it('defaults to the vendored coin-registry pin when no host env is set', async function () {
                    const { getCoinConfigByFullName } = require('../../src/coins')
                    const pinned = getCoinConfigByFullName('bitcoin', 'regtest').addresses.FEE_DESTINATION
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
                    expect(config['FEE_DESTINATION']).to.equal(pinned)
                    expect(config[FEE_ENV]).to.equal(pinned)
                })

                it('ignores host env overrides on mainnet and injects the registry pin', async function () {
                    const MAINNET_ENV = 'XCHAIN_FEE_DESTINATION_BTC_MAINNET'
                    const savedMainnet = process.env[MAINNET_ENV]
                    process.env[MAINNET_ENV] = 'mEvilOverrideAddr333'
                    process.env.FEE_DESTINATION = 'mEvilGenericAddr444'
                    try {
                        const { getCoinConfigByFullName } = require('../../src/coins')
                        const cs = makeServiceWithConfig('')
                        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                        // resolveFeeDestination ignores the per-coin override on mainnet; the
                        // generic var must be ignored there too (fee acceptance is consensus).
                        const pinned = '1FeesxM9LTEjBYVTkynK6jfDBgvksuh2WL'
                        expect(getCoinConfigByFullName('bitcoin', 'mainnet').addresses.FEE_DESTINATION).to.equal(pinned)
                        expect(config['FEE_DESTINATION']).to.equal(pinned)
                        expect(config[MAINNET_ENV]).to.equal(pinned)
                    } finally {
                        if (savedMainnet === undefined) delete process.env[MAINNET_ENV]; else process.env[MAINNET_ENV] = savedMainnet
                    }
                })
            })

            describe('genesis-ledger bootstrap passthrough', function () {
                const GENESIS_VARS = [
                    'XCHAIN_GENESIS_BLOCK', 'XCHAIN_GENESIS_LEDGER_HASH', 'XCHAIN_GENESIS_DUMP_HASH',
                    'GENESIS_LEDGER_PATH', 'GENESIS_DUMP_PATH',
                    'GENESIS_BLOCK_TIMEOUT_MS', 'GENESIS_DUMP_TIMEOUT_MS'
                ]
                let saved
                beforeEach(function () {
                    saved = {}
                    for (const v of GENESIS_VARS) { saved[v] = process.env[v]; delete process.env[v] }
                })
                afterEach(function () {
                    for (const v of GENESIS_VARS) {
                        if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]
                    }
                })

                it('injects the genesis env vars into the indexer config from the host env', async function () {
                    process.env.XCHAIN_GENESIS_BLOCK       = '105'
                    process.env.XCHAIN_GENESIS_LEDGER_HASH = 'deadbeef'
                    process.env.XCHAIN_GENESIS_DUMP_HASH   = 'cafef00d'
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                    expect(config['XCHAIN_GENESIS_BLOCK']).to.equal('105')
                    expect(config['XCHAIN_GENESIS_LEDGER_HASH']).to.equal('deadbeef')
                    expect(config['XCHAIN_GENESIS_DUMP_HASH']).to.equal('cafef00d')
                })

                it('does NOT inject genesis vars into a non-indexer module (decoder)', async function () {
                    process.env.XCHAIN_GENESIS_BLOCK = '105'
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
                    expect(config).to.not.have.property('XCHAIN_GENESIS_BLOCK')
                })

                it('omits genesis vars entirely when unset (genesis stays disabled)', async function () {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                    for (const v of GENESIS_VARS) expect(config).to.not.have.property(v)
                })
            })

            it('returns correct INDEXER_COIN ticker', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
                expect(config['INDEXER_COIN']).to.equal('BTC')
            })

            it('returns correct INDEXER_COIN for dogecoin', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'mainnet')
                expect(config['INDEXER_COIN']).to.equal('DOGE')
            })

            it('returns HUB_PORT as 10000', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['HUB_PORT']).to.equal(10000)
            })

            it('includes REGTEST_MINER_URL for regtest network', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')
                expect(config['REGTEST_MINER_URL']).to.exist
                expect(config['REGTEST_MINER_API_PORT']).to.equal(3005)
            })

            it('does not include REGTEST_MINER_URL for mainnet', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['REGTEST_MINER_URL']).to.be.undefined
            })

            it('does not include REGTEST_MINER_URL for testnet', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'testnet')
                expect(config['REGTEST_MINER_URL']).to.be.undefined
            })

            it('config file values override defaults', async function () {
                const cs = makeServiceWithConfig('UTXO_TRACKER_PORT=9999\n')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['UTXO_TRACKER_PORT']).to.equal('9999')
            })

            it('default values used when config file is empty', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['UTXO_TRACKER_API_PORT']).to.equal(3001)
                expect(config['DECODER_API_PORT']).to.equal(3002)
                expect(config['ENCODER_API_PORT']).to.equal(3003)
                expect(config['INDEXER_API_PORT']).to.equal(3004)
            })

            it('returns correct DECODER_DB_USER format', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_USER']).to.equal('xchain_decoder_bitcoin_mainnet')
            })

            it('returns correct INDEXER_DB_USER format', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'testnet')
                expect(config['INDEXER_DB_USER']).to.equal('xchain_indexer_dogecoin_testnet')
            })

            it('returns DECODER_DB_HOST as mariadb', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_HOST']).to.equal('mariadb')
            })

            it('returns DECODER_DB_PORT as 3306', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                expect(config['DECODER_DB_PORT']).to.equal(3306)
            })
        })

        describe('without coin/network (shared service config)', function () {

            it('returns HUB_PORT as 10000', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                expect(config['HUB_PORT']).to.equal(10000)
            })

            it('returns EXPLORER_PORT as 18080', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
                expect(config['EXPLORER_PORT']).to.equal(18080)
                expect(config['EXPLORER_PORT_HTTP']).to.equal(18080)
            })

            it('returns EXPLORER_API_PORT_HTTP as 8080', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
                expect(config['EXPLORER_API_PORT_HTTP']).to.equal(8080)
            })

            it('returns EXPLORER_PORT_HTTPS as 18081', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
                expect(config['EXPLORER_PORT_HTTPS']).to.equal(18081)
            })

            it('returns SYNC_MODE as server', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
                expect(config['SYNC_MODE']).to.equal('server')
            })

            it('passes HUB_API_KEY through from host env to shared-service configs (keyed sensitive-read tier)', async function () {
                const prev = process.env.HUB_API_KEY
                process.env.HUB_API_KEY = 'hub-secret-456'
                try {
                    const cs = makeServiceWithConfig('')
                    const syncCfg = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
                    expect(syncCfg['HUB_API_KEY']).to.equal('hub-secret-456')
                    const explorerCfg = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
                    expect(explorerCfg['HUB_API_KEY']).to.equal('hub-secret-456')
                } finally {
                    if (prev === undefined) delete process.env.HUB_API_KEY
                    else process.env.HUB_API_KEY = prev
                }
            })

            it('omits HUB_API_KEY from shared-service configs when unset in host env', async function () {
                const prev = process.env.HUB_API_KEY
                delete process.env.HUB_API_KEY
                try {
                    const cs = makeServiceWithConfig('')
                    const syncCfg = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
                    expect(syncCfg['HUB_API_KEY']).to.equal(undefined)
                } finally {
                    if (prev === undefined) delete process.env.HUB_API_KEY
                    else process.env.HUB_API_KEY = prev
                }
            })

            it('returns SYNC_API_PORT as 3006', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(SYNC_MODULE_NAME, null, null)
                expect(config['SYNC_API_PORT']).to.equal(3006)
            })

            it('does not include coin-specific keys like NODE_PORT', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                expect(config['NODE_PORT']).to.be.undefined
                expect(config['DECODER_DB_NAME']).to.be.undefined
            })

            describe('HUB_NETWORK passthrough', function () {
                let saved
                beforeEach(function () { saved = process.env.HUB_NETWORK; delete process.env.HUB_NETWORK })
                afterEach(function () { if (saved === undefined) delete process.env.HUB_NETWORK; else process.env.HUB_NETWORK = saved })

                it('injects HUB_NETWORK from host env into the hub config', async function () {
                    process.env.HUB_NETWORK = 'mainnet'
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                    expect(config['HUB_NETWORK']).to.equal('mainnet')
                })

                it('leaves HUB_NETWORK unset when host env is absent (standalone unchanged)', async function () {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                    expect(config['HUB_NETWORK']).to.be.undefined
                })
            })
        })
    })

    // -------------------------------------------------------------------
    // filterCommandParameters
    // -------------------------------------------------------------------

    describe('filterCommandParameters()', function () {
        const { filterCommandParameters } = require('../../src/services/ConfigService')

        it('passes single module/coin/network through unchanged', function () {
            const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'mainnet')
            expect(result['bitcoin']['mainnet']).to.deep.equal(['xchain-encoder'])
        })

        it('expands "all" coins to bitcoin, dogecoin, litecoin', function () {
            const result = filterCommandParameters(null, 'xchain-encoder', 'all', 'mainnet')
            expect(result).to.have.property('bitcoin')
            expect(result).to.have.property('dogecoin')
            expect(result).to.have.property('litecoin')
        })

        it('expands "all" networks to mainnet, testnet, regtest', function () {
            const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'all')
            expect(result['bitcoin']).to.have.property('mainnet')
            expect(result['bitcoin']).to.have.property('testnet')
            expect(result['bitcoin']).to.have.property('regtest')
        })

        it('expands "all" modules to full service list plus node', function () {
            const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
            const modules = result['bitcoin']['mainnet']
            expect(modules).to.include('xchain-encoder')
            expect(modules).to.include('xchain-decoder')
            expect(modules).to.include('xchain-utxo-tracker')
            expect(modules).to.include('xchain-indexer')
            expect(modules).to.include('node')
        })

        it('filters regtest-only modules from mainnet', function () {
            const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
            const modules = result['bitcoin']['mainnet']
            expect(modules).to.not.include('xchain-regtest-miner')
            expect(modules).to.not.include('xchain-e2e-test')
        })

        it('filters regtest-only modules from testnet', function () {
            const result = filterCommandParameters(null, 'all', 'bitcoin', 'testnet')
            const modules = result['bitcoin']['testnet']
            expect(modules).to.not.include('xchain-regtest-miner')
            expect(modules).to.not.include('xchain-e2e-test')
        })

        it('includes regtest-miner for regtest but excludes e2e-test from all', function () {
            const result = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            const modules = result['bitcoin']['regtest']
            expect(modules).to.include('xchain-regtest-miner')
            expect(modules).to.not.include('xchain-e2e-test')
        })

        it('adds explorer to servicesList[""][""] when modules is "all"', function () {
            const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
            expect(result['']).to.exist
            expect(result[''][''][0]).to.equal('xchain-explorer')
        })

        it('handles "explorer" module name', function () {
            const result = filterCommandParameters(null, 'explorer', 'bitcoin', 'mainnet')
            expect(result['']).to.exist
            expect(result[''][''][0]).to.equal('xchain-explorer')
        })

        it('handles "node" module name', function () {
            const result = filterCommandParameters(null, 'node', 'bitcoin', 'mainnet')
            expect(result['bitcoin']['mainnet']).to.deep.equal(['node'])
        })

        it('returns correct structure for all coins + all networks + all modules', function () {
            const result = filterCommandParameters(null, 'all', 'all', 'all')
            for (const coin of Object.values(Coin)) {
                expect(result).to.have.property(coin)
                for (const network of Object.values(Network)) {
                    expect(result[coin]).to.have.property(network)
                    const modules = result[coin][network]
                    expect(modules).to.include('xchain-encoder')
                    if (network === 'regtest') {
                        expect(modules).to.include('xchain-regtest-miner')
                    } else {
                        expect(modules).to.not.include('xchain-regtest-miner')
                    }
                }
            }
        })

        it('handles null coins (expands to all)', function () {
            const result = filterCommandParameters(null, 'xchain-encoder', null, 'mainnet')
            expect(result).to.have.property('bitcoin')
            expect(result).to.have.property('dogecoin')
            expect(result).to.have.property('litecoin')
        })

        it('handles null networks (expands to all)', function () {
            const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', null)
            expect(result['bitcoin']).to.have.property('mainnet')
            expect(result['bitcoin']).to.have.property('testnet')
            expect(result['bitcoin']).to.have.property('regtest')
        })
    })
})
