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

// getDefaultConfig() pulls ValidatorService in lazily for the hub module, and
// ValidatorService reads config/validator/ off the REAL filesystem through its own
// `fs` binding, which the fs stub below does not reach. On a developer or operator
// box that has run `xchain-node validator init` that directory exists, so an
// unstubbed run reads the machine's recorded network (HUB_NETWORK) and its live
// signing.key into the config object under test: assertions about a standalone
// install then fail, and a real key ends up in a test fixture. Every factory here
// therefore describes a machine with no validator, which is the state CI runs in
// (config/validator/ is gitignored). Tests that WANT a validator stub their own.
const NO_VALIDATOR = {
    getValidatorSettings: () => null,
    getValidatorEnv:      () => ({})
}

function makeConfigService(fsStub) {
    return proxyquire('../../src/services/ConfigService', {
        'fs': fsStub || require('fs'),
        './ValidatorService': NO_VALIDATOR
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

    describe('persistSidecarCreds()', function () {
        const fs = require('fs')
        const os = require('os')
        const { persistSidecarCreds } = require('../../src/services/ConfigService')

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
    })

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
                return proxyquire('../../src/services/ConfigService', {
                    'fs': fsStub,
                    './ValidatorService': {
                        getValidatorSettings: () => validatorSettings,
                        getValidatorEnv: () => ({})
                    }
                })
            }

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
                    './ValidatorService': NO_VALIDATOR,
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

            it('generates the MISSING RPC credential when only one of NODE_USER/NODE_PASSWORD is present (#2404: no both-or-nothing fallback to "rpc")', async function () {
                // The old both-absent (&&) guard let a partial sidecar generate nothing, so
                // the missing half silently resolved to the static "rpc" default.
                const { cs } = makeMemoryConfigService({ [coinSidecar]: 'NODE_PASSWORD=operatorpass\n' })
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['NODE_PASSWORD']).to.equal('operatorpass')        // present half preserved
                expect(config['NODE_USER']).to.be.a('string').with.length.greaterThan(0)
                expect(config['NODE_USER']).to.not.equal('rpc')                 // missing half generated, not the static default
            })

            it('recovers RPC credentials glued onto a preceding setting with no separating newline (#2405)', async function () {
                // Older appenders wrote NODE_USER= onto the last main-file line with no
                // leading newline (e.g. `DUST_AMOUNT=546NODE_USER=<hex>`), corrupting the
                // value and hiding the credential from the migration.
                const gluedUser = 'a'.repeat(24)
                const gluedPass = 'b'.repeat(48)
                const { cs, files } = makeMemoryConfigService({ [coinMain]: 'DUST_AMOUNT=546NODE_USER=' + gluedUser + '\nNODE_PASSWORD=' + gluedPass + '\n' })
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(String(config['DUST_AMOUNT'])).to.equal('546')           // value no longer corrupted by the glued credential
                expect(config['NODE_USER']).to.equal(gluedUser)                 // credential recovered, not regenerated
                expect(config['NODE_PASSWORD']).to.equal(gluedPass)
                expect(files[coinMain] || '').to.not.include('NODE_USER=')      // stripped from the main file
                expect(files[coinSidecar] || '').to.include('NODE_USER=' + gluedUser)  // relocated to the sidecar
            })

            // A validator-mode hub REFUSES TO BOOT with no HUB_API_KEY, and `validator init`
            // now leaves one in the shared hub sidecar. These pin the consumption half: the
            // generated credential has to reach the hub container, and every service on the
            // host that authenticates to that hub has to present the SAME value.
            describe('HUB_API_KEY from the shared hub sidecar', function () {
                // Not a credential: a fixture value chosen to be unmistakable in a diff.
                const SIDECAR_FIXTURE = 'sidecar-fixture-value-not-a-credential'
                let saved

                beforeEach(function () {
                    saved = {}
                    for (const k of ['HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED', 'HUB_NETWORK']) {
                        saved[k] = process.env[k]
                        delete process.env[k]
                    }
                })
                afterEach(function () {
                    for (const [k, v] of Object.entries(saved)) {
                        if (v === undefined) delete process.env[k]
                        else process.env[k] = v
                    }
                })

                it('deploys the hub KEYED off the sidecar instead of declaring it keyless', async function () {
                    const { cs } = makeMemoryConfigService({ [hubSidecar]: 'HUB_API_KEY=' + SIDECAR_FIXTURE + '\n' })
                    const cfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
                    expect(cfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
                })

                // Otherwise the fix just moves the dead node downstream: a keyed hub 401s
                // the co-located indexer's chain-tip writes.
                it('gives the co-located indexer the same key the hub runs with', async function () {
                    const { cs } = makeMemoryConfigService({ [hubSidecar]: 'HUB_API_KEY=' + SIDECAR_FIXTURE + '\n' })
                    const hubCfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
                    const idxCfg = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'testnet')
                    const syncCfg = await cs.getDefaultConfig(SYNC_MODULE_NAME, '', '')
                    // Named explicitly, not just compared: two services that both resolved
                    // NOTHING are equal too, and that is the outage this pins against.
                    expect(hubCfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
                    expect(idxCfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
                    expect(syncCfg['HUB_API_KEY']).to.equal(SIDECAR_FIXTURE)
                })

                it('yields to a host-env key (an operator override is never overwritten)', async function () {
                    process.env.HUB_API_KEY = 'host-env-fixture-value'
                    const { cs } = makeMemoryConfigService({ [hubSidecar]: 'HUB_API_KEY=' + SIDECAR_FIXTURE + '\n' })
                    const cfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
                    expect(cfg['HUB_API_KEY']).to.equal('host-env-fixture-value')
                })

                // A node that never ran `validator init` must deploy exactly as before:
                // this path reads, it never mints.
                it('leaves a node with no generated key on its prior keyless declaration', async function () {
                    const { cs, files } = makeMemoryConfigService()
                    const cfg = await cs.getDefaultConfig(HUB_MODULE_NAME, '', '')
                    expect(cfg['HUB_API_KEY']).to.equal(undefined)
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
                    expect(files[hubSidecar] || '').to.not.include('HUB_API_KEY=')
                })
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

            // #2246: on the non-rotatable path INDEXER_DB_PASS is not yet in
            // defaultConfig when the indexer's HUB_DB_PASS bind runs, so the old
            // unconditional copy planted HUB_DB_PASS=undefined - the key then
            // "existed", the shared/static fallbacks skipped it, and the container
            // got HUB_DB_PASS="undefined" against an account whose password fell
            // through to the static default (HubDbSync ER_ACCESS_DENIED lockout).
            it('indexer HUB_DB_PASS matches the indexer account static default when rotation cannot apply (never undefined)', async function () {
                const { cs } = makeMemoryConfigService()
                const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
                expect(config['HUB_DB_PASS']).to.equal('xchain' + SEP + 'password')
                expect(config['HUB_DB_PASS']).to.equal(config['INDEXER_DB_PASS'])
            })

            it('indexer HUB_DB_PASS matches the generated per-install INDEXER_DB_PASS when rotation can apply', async function () {
                const { cs } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
                const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
                expect(config['INDEXER_DB_PASS']).to.match(/^[0-9a-f]{48}$/)
                expect(config['HUB_DB_PASS']).to.equal(config['INDEXER_DB_PASS'])
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
                    'GENESIS_BLOCK_TIMEOUT_MS', 'GENESIS_DUMP_TIMEOUT_MS',
                    'GENESIS_AIRDROP_PATHS', 'GENESIS_AIRDROP_HASHES', 'GENESIS_AIRDROP_AMOUNTS',
                    'GENESIS_AIRDROP_SNAPSHOT_BLOCK', 'GENESIS_AIRDROP_SET_HASH'
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

                it('passes the airdrop set through to the indexer (regtest dry-run seam)', async function () {
                    process.env.GENESIS_AIRDROP_PATHS    = '/XChainIndexer/data/genesis/xcp.csv'
                    process.env.GENESIS_AIRDROP_HASHES   = 'aa'
                    process.env.GENESIS_AIRDROP_AMOUNTS  = '30000000.00000000'
                    process.env.GENESIS_AIRDROP_SET_HASH = 'd'.repeat(64)
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                    expect(config['GENESIS_AIRDROP_PATHS']).to.equal('/XChainIndexer/data/genesis/xcp.csv')
                    expect(config['GENESIS_AIRDROP_HASHES']).to.equal('aa')
                    expect(config['GENESIS_AIRDROP_AMOUNTS']).to.equal('30000000.00000000')
                    expect(config['GENESIS_AIRDROP_SET_HASH']).to.equal('d'.repeat(64))
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

            // The indexer's hub client is enabled purely by HUB_API_URL
            // (hub_client.js `this.enabled = !!this.hubUrl`). HUB_API_HOST is set here
            // but read by nothing in xchain-indexer, so while HUB_API_URL was unset the
            // client stayed disabled on every installed stack and no push ever left the
            // indexer, including the PRICE v1 oracle_price pushes a FIAT dispenser later
            // prices against.
            it('sets HUB_API_URL so the indexer hub client is enabled', async function () {
                const cs = makeServiceWithConfig('')
                for (const network of ['regtest', 'testnet', 'mainnet']) {
                    const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', network)
                    expect(config['HUB_API_URL'], network).to.be.a('string')
                    expect(config['HUB_API_URL'], network).to.match(/^http:\/\/.+:10000$/)
                }
            })

            it('points HUB_API_URL at the same hub container HUB_API_HOST names', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
                expect(config['HUB_API_URL']).to.equal(
                    'http://' + config['HUB_API_HOST'] + ':' + config['HUB_PORT'])
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

            // The explorer's quote/pre-flight proxies resolve their
            // upstream from these, and their absence fails SOFT: the routes
            // answer INDEXER_NOT_CONFIGURED and the wallet quietly drops to
            // its client-side pre-flight tier rather than erroring. Nothing
            // in the running system complains, so pin the emission here.
            it('emits INDEXER_API_URL_<COIN>_<NETWORK> for every coin and network', async function () {
                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
                expect(config['INDEXER_API_URL_BTC_REGTEST'])
                    .to.equal('http://xchain-node-bitcoin-regtest-xchain-indexer:3004')
                expect(config['INDEXER_API_URL_BTC_MAINNET'])
                    .to.equal('http://xchain-node-bitcoin-mainnet-xchain-indexer:3004')
                expect(config['INDEXER_API_URL_LTC_REGTEST'])
                    .to.equal('http://xchain-node-litecoin-regtest-xchain-indexer:3004')
                expect(config['INDEXER_API_URL_DOGE_TESTNET'])
                    .to.equal('http://xchain-node-dogecoin-testnet-xchain-indexer:3004')
            })

            // The container-local default must never win over an operator's
            // value: an explorer whose indexers live on other boxes sets this
            // by hand, and overriding it would point a working
            // production explorer at a hostname that does not resolve.
            it('yields INDEXER_API_URL_<COIN>_<NETWORK> to the host env', async function () {
                const prev = process.env.INDEXER_API_URL_BTC_MAINNET
                process.env.INDEXER_API_URL_BTC_MAINNET = 'http://203.0.113.5:3004'
                try {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
                    expect(config['INDEXER_API_URL_BTC_MAINNET']).to.equal('http://203.0.113.5:3004')
                    // Unrelated coins keep the container-local default.
                    expect(config['INDEXER_API_URL_LTC_MAINNET'])
                        .to.equal('http://xchain-node-litecoin-mainnet-xchain-indexer:3004')
                } finally {
                    if (prev === undefined) delete process.env.INDEXER_API_URL_BTC_MAINNET
                    else process.env.INDEXER_API_URL_BTC_MAINNET = prev
                }
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

            // The hub refuses to boot on an UNDECLARED unauthenticated
            // write surface. A managed keyless deploy is still legitimate, so the
            // deployer makes the declaration; without it the container would
            // crash-loop the way over-tightening the indexer (771880c) and the
            // encoder (e2bf7c4) did pre-launch.
            describe('hub keyless declaration', function () {

                async function hubConfigWith(env) {
                    const saved = {}
                    for (const k of ['HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED', 'HUB_NETWORK']) {
                        saved[k] = process.env[k]
                        delete process.env[k]
                    }
                    Object.assign(process.env, env)
                    try {
                        const cs = makeServiceWithConfig('')
                        return await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                    } finally {
                        for (const [k, v] of Object.entries(saved)) {
                            if (v === undefined) delete process.env[k]
                            else process.env[k] = v
                        }
                    }
                }

                it('declares keyless operation when no HUB_API_KEY is in the host env', async function () {
                    const cfg = await hubConfigWith({})
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
                })

                it('does not declare keyless when a key is present (the hub is keyed)', async function () {
                    const cfg = await hubConfigWith({ HUB_API_KEY: 'hub-secret-456' })
                    expect(cfg['HUB_API_KEY']).to.equal('hub-secret-456')
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
                })

                it('yields to an explicit host-env refusal (HUB_ALLOW_UNAUTHENTICATED=false)', async function () {
                    const cfg = await hubConfigWith({ HUB_ALLOW_UNAUTHENTICATED: 'false' })
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('false')
                })

                // Real funds behind it: on mainnet the deployer does NOT declare
                // keyless for the operator, so the hub's refusal stands and the
                // deploy fails loudly instead of serving an open write surface.
                it('does NOT declare keyless on a mainnet hub', async function () {
                    const cfg = await hubConfigWith({ HUB_NETWORK: 'mainnet' })
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal(undefined)
                })

                it('still declares keyless on a regtest hub', async function () {
                    const cfg = await hubConfigWith({ HUB_NETWORK: 'regtest' })
                    expect(cfg['HUB_ALLOW_UNAUTHENTICATED']).to.equal('true')
                })
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

                // The guard on the guard: the test above only describes a standalone
                // install while ValidatorService is stubbed out. Unstubbed it reads the
                // real config/validator/ through its own fs binding, so on any box that
                // has run `validator init` the suite both fails here and pulls that
                // machine's live signing key into a fixture. Assert the validator env is
                // absent, which is the shape only an isolated read can produce.
                it('reads no validator identity off the host filesystem', async function () {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                    expect(config['SIGNING_PRIVKEY_HEX']).to.be.undefined
                    expect(config['P2P_VALIDATOR_ADDR']).to.be.undefined
                    expect(config['HUB_CAPABILITY_CONFIG']).to.be.undefined
                })
            })

            // The four PRICE batch knobs: non-consensus, so a passthrough
            // omission just leaves the hub on its own default rather than drifting
            // a federation, but an operator install still needs them to reach the
            // container to tune window/grace/timeout/buffer at all.
            describe('ORACLE_BATCH_* passthrough', function () {
                const ORACLE_BATCH_VARS = [
                    'ORACLE_BATCH_WINDOW_ROUNDS', 'ORACLE_BATCH_GRACE_MS',
                    'ORACLE_BATCH_SIGN_TIMEOUT_MS', 'ORACLE_BATCH_BUFFER_MAX_ROUNDS'
                ]
                let saved
                beforeEach(function () {
                    saved = {}
                    for (const k of ORACLE_BATCH_VARS) { saved[k] = process.env[k]; delete process.env[k] }
                })
                afterEach(function () {
                    for (const [k, v] of Object.entries(saved)) {
                        if (v === undefined) delete process.env[k]
                        else process.env[k] = v
                    }
                })

                it('injects all four ORACLE_BATCH_* knobs from host env into the hub config', async function () {
                    process.env.ORACLE_BATCH_WINDOW_ROUNDS = '6'
                    process.env.ORACLE_BATCH_GRACE_MS = '300000'
                    process.env.ORACLE_BATCH_SIGN_TIMEOUT_MS = '60000'
                    process.env.ORACLE_BATCH_BUFFER_MAX_ROUNDS = '4032'
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                    expect(config['ORACLE_BATCH_WINDOW_ROUNDS']).to.equal('6')
                    expect(config['ORACLE_BATCH_GRACE_MS']).to.equal('300000')
                    expect(config['ORACLE_BATCH_SIGN_TIMEOUT_MS']).to.equal('60000')
                    expect(config['ORACLE_BATCH_BUFFER_MAX_ROUNDS']).to.equal('4032')
                })

                it('leaves all four ORACLE_BATCH_* knobs unset when host env is absent (hub default unchanged)', async function () {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                    for (const k of ORACLE_BATCH_VARS) expect(config[k]).to.be.undefined
                })
            })
        })
    })

    // The credential `validator init` mints so the hub can boot at all. Driven against a
    // REAL temp directory: the whole value of this function is the file it leaves behind -
    // its mode, its other keys, its stability across runs - and a stubbed fs shows none of
    // that. Every assertion here is on SHAPE read back out of the file; the generated value
    // is never returned by the code and is never rendered by a test, so a failing assertion
    // cannot print a live credential.
    describe('ensureHubApiKey()', function () {
        const os     = require('os')
        const realFs = require('fs')
        const crypto = require('crypto')
        let dir

        function serviceWithConfigDir(d) {
            return proxyquire('../../src/services/ConfigService', {
                '../config/constants': { ...require('../../src/config/constants'), configDir: d }
            })
        }

        function sidecarPath() { return path.join(dir, 'hub.local') }

        function readKeyShape() {
            const line = realFs.readFileSync(sidecarPath(), 'utf8')
                .split(/\r?\n/).find(l => l.startsWith('HUB_API_KEY='))
            if (!line) return null
            const value = line.slice('HUB_API_KEY='.length)
            return { length: value.length, hex: /^[0-9a-f]+$/.test(value) }
        }

        // Identity of the file's CONTENT without holding the content: proof that a second
        // run left the credential untouched, printable in a failure message.
        function sidecarDigest() {
            return crypto.createHash('sha256').update(realFs.readFileSync(sidecarPath())).digest('hex')
        }

        beforeEach(function () { dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'xchain-hub-api-key-')) })
        afterEach(function () { realFs.rmSync(dir, { recursive: true, force: true }) })

        it('generates a key into the shared hub sidecar on a host that has none', async function () {
            const cs = serviceWithConfigDir(dir)
            const result = await cs.ensureHubApiKey()
            expect(result.generated).to.be.true
            expect(result.path).to.equal(sidecarPath())
            expect(readKeyShape()).to.deep.equal({ length: 64, hex: true })
        })

        it('locks the sidecar to 0600, so no other local user can read the credential', async function () {
            const cs = serviceWithConfigDir(dir)
            await cs.ensureHubApiKey()
            expect(realFs.statSync(sidecarPath()).mode & 0o777).to.equal(0o600)
        })

        // The strongest no-leak guarantee available: a value the function does not hand
        // back cannot be logged, echoed into a report, or asserted on by mistake.
        it('never returns the key itself, only where it lives', async function () {
            const cs = serviceWithConfigDir(dir)
            const result = await cs.ensureHubApiKey()
            expect(Object.keys(result).sort()).to.deep.equal(['generated', 'path'])
            expect(JSON.stringify(result)).to.not.match(/[0-9a-f]{64}/)
        })

        // Rotating on a re-run would 401 every indexer and explorer already configured
        // with the old key, which is a worse outage than the one this closes.
        it('reuses an existing key and leaves the file byte-identical', async function () {
            const cs = serviceWithConfigDir(dir)
            await cs.ensureHubApiKey()
            const before = sidecarDigest()
            const second = await cs.ensureHubApiKey()
            expect(second.generated).to.be.false
            expect(second.path).to.equal(sidecarPath())
            expect(sidecarDigest()).to.equal(before)
        })

        it('adopts a key the operator wrote by hand rather than replacing it', async function () {
            realFs.writeFileSync(sidecarPath(), 'HUB_API_KEY=operator-written-fixture\n', { mode: 0o600 })
            const before = sidecarDigest()
            const cs = serviceWithConfigDir(dir)
            const result = await cs.ensureHubApiKey()
            expect(result.generated).to.be.false
            expect(sidecarDigest()).to.equal(before)
        })

        // The same file already carries HUB_DB_PASS. Clobbering it would take the hub's
        // database down as the price of giving it an API key.
        it('preserves the other credentials already in the sidecar', async function () {
            realFs.writeFileSync(sidecarPath(), 'HUB_DB_PASS=db-fixture-value\n', { mode: 0o600 })
            const cs = serviceWithConfigDir(dir)
            await cs.ensureHubApiKey()
            const body = realFs.readFileSync(sidecarPath(), 'utf8')
            expect(body).to.include('HUB_DB_PASS=db-fixture-value')
            expect(readKeyShape()).to.deep.equal({ length: 64, hex: true })
        })

        it('creates the config directory when it does not exist yet', async function () {
            const nested = path.join(dir, 'not-created-yet')
            const cs = serviceWithConfigDir(nested)
            const result = await cs.ensureHubApiKey()
            expect(result.generated).to.be.true
            expect(realFs.existsSync(path.join(nested, 'hub.local'))).to.be.true
        })
    })

    describe('filterCommandParameters()', function () {

        // The non-minting read. A key APPEARING on a keyless host 401s every consumer that
        // carries none, so callers that only need to report where the credential lives must
        // have a way to ask that cannot create one.
        describe('readHubApiKey()', function () {

            it('reports absence and writes NOTHING on a keyless host', async function () {
                const cs = serviceWithConfigDir(dir)
                const result = await cs.readHubApiKey()
                expect(result.present).to.be.false
                expect(result.path).to.equal(sidecarPath())
                expect(realFs.existsSync(sidecarPath())).to.be.false
            })

            it('leaves a sidecar that holds other credentials byte-identical', async function () {
                realFs.writeFileSync(sidecarPath(), 'HUB_DB_PASS=db-fixture-value\n', { mode: 0o600 })
                const before = sidecarDigest()
                const cs = serviceWithConfigDir(dir)
                expect((await cs.readHubApiKey()).present).to.be.false
                expect(sidecarDigest()).to.equal(before)
            })

            it('reports a present key without rotating it', async function () {
                const cs = serviceWithConfigDir(dir)
                await cs.ensureHubApiKey()
                const before = sidecarDigest()
                const result = await cs.readHubApiKey()
                expect(result.present).to.be.true
                expect(sidecarDigest()).to.equal(before)
            })

            it('never returns the key itself, only whether there is one', async function () {
                const cs = serviceWithConfigDir(dir)
                await cs.ensureHubApiKey()
                const result = await cs.readHubApiKey()
                expect(Object.keys(result).sort()).to.deep.equal(['path', 'present'])
                expect(JSON.stringify(result)).to.not.match(/[0-9a-f]{64}/)
            })
        })
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

        // recreate/start/stop/logs pass the operator's raw token straight here
        // without going through resolveArgs, so the alias has to apply in both.
        it('accepts the short shared-service names operators actually type', function () {
            expect(filterCommandParameters(null, 'hub',  null, null)['']).to.deep.equal({ '': ['xchain-hub'] })
            expect(filterCommandParameters(null, 'sync', null, null)['']).to.deep.equal({ '': ['xchain-sync'] })
            expect(filterCommandParameters(null, 'db',   null, null)['']).to.deep.equal({ '': ['database'] })
        })
    })

    describe('resolveArgs() service resolution', function () {
        const { resolveArgs } = require('../../src/services/ConfigService')

        it('resolves the canonical shared-service names', function () {
            expect(resolveArgs(['master', 'xchain-hub'], { expectBranch: true }))
                .to.include({ service: 'xchain-hub', branch: 'master' })
        })

        it('resolves the short shared-service aliases to their canonical names', function () {
            expect(resolveArgs(['master', 'hub'],  { expectBranch: true })).to.include({ service: 'xchain-hub' })
            expect(resolveArgs(['master', 'sync'], { expectBranch: true })).to.include({ service: 'xchain-sync' })
            expect(resolveArgs(['master', 'db'],   { expectBranch: true })).to.include({ service: 'database' })
        })

        // The bug: an unrecognized token was silently dropped, leaving
        // service='all'. `install master hub` did not refuse the unknown name, it
        // installed EVERY service on every coin and network. The 'xchain-node'
        // guard already documented this trap but covered only that one name.
        it('refuses an unrecognized service name instead of expanding to every service', function () {
            expect(() => resolveArgs(['master', 'hubb'], { expectBranch: true }))
                .to.throw(/Unrecognized argument 'hubb'/)
            expect(() => resolveArgs(['master', 'xchain-indexr'], { expectBranch: true }))
                .to.throw(/Unrecognized argument/)
        })

        it('names the valid services in the refusal, so the operator can correct it', function () {
            try {
                resolveArgs(['master', 'hubb'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('xchain-hub')
                expect(err.message).to.include('xchain-indexer')
                expect(err.message).to.include('bitcoin')
                expect(err.message).to.include('testnet')
            }
        })

        it('still accepts every legitimate argument shape', function () {
            expect(resolveArgs(['master', 'xchain-indexer', 'bitcoin', 'mainnet'], { expectBranch: true }))
                .to.include({ service: 'xchain-indexer', chain: 'bitcoin', network: 'mainnet', branch: 'master' })
            expect(resolveArgs(['master', 'all'], { expectBranch: true }))
                .to.include({ service: 'all', branch: 'master' })
            expect(resolveArgs(['master', 'node', 'litecoin', 'testnet'], { expectBranch: true }))
                .to.include({ service: 'node', chain: 'litecoin', network: 'testnet' })
            expect(resolveArgs(['xchain-decoder', 'bitcoin', 'regtest'], { expectBranch: false }))
                .to.include({ service: 'xchain-decoder', chain: 'bitcoin', network: 'regtest' })
        })

        // A branch name is an arbitrary string, so the free slot must still take
        // one; the refusal only fires once that slot is spoken for.
        it('leaves the branch slot free to take an arbitrary name', function () {
            expect(resolveArgs(['feature/some-branch', 'xchain-indexer'], { expectBranch: true }))
                .to.include({ service: 'xchain-indexer', branch: 'feature/some-branch' })
        })
    })
})
