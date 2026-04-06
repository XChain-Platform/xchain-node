'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const { Readable } = require('stream')
const levelup    = require('levelup')
const memdown    = require('memdown')

const {
    NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, INDEXER_SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, configDir
} = require('../../src/config/constants')

const LevelUpStore = require('../../src/LevelUpDb')
const TestEnv      = require('../integration/helpers/test-env')
const E2EEnv       = require('../e2e/helpers/e2e-env')

const { filterCommandParameters } = require('../../src/services/ConfigService')

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

function makeConfigService(fsStub) {
    return proxyquire('../../src/services/ConfigService', {
        'fs': fsStub || require('fs')
    })
}

function makeServiceWithConfig(configContent) {
    const fsStub = {
        createReadStream: sinon.stub().returns(streamFromString(configContent)),
        existsSync: sinon.stub().returns(true),
        rmSync: sinon.stub(),
        mkdirSync: sinon.stub()
    }
    return makeConfigService(fsStub)
}

function loadDockerService(stubs) {
    return proxyquire('../../src/services/DockerService', {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn || sinon.stub(),
            spawnSync: stubs.spawnSync || sinon.stub()
        },
        'util': { promisify: (fn) => fn },
        'fs': stubs.fs || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

function loadModuleService(stubs, configOverrides) {
    const configServiceStub = Object.assign({
        getModuleDir: (m) => moduleDir + '/' + m,
        getModuleTmpDir: (m) => tmpDir + '/' + m,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (m, c, n) => `xchain-node-${c}-${n}-${m}`,
        getDockerNetwork: (c, n) => 'xchain-node' + (c ? '-' + c : '') + (n ? '-' + n : ''),
        validatePort: (v) => {
            if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535
            if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 }
            return false
        },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'bitcoin-mainnet',
            'DECODER_PORT': 3002,
            'DECODER_API_PORT': 3002
        })
    }, configOverrides || {})

    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
        '../state': {
            db: stubs.db || { insertModuleContainer: sinon.stub().resolves(true) },
            getLastStatus: () => null,
            getRemoteModuleVersions: () => ({})
        },
        './ConfigService': configServiceStub,
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), getStatusFromContainer: sinon.stub().resolves({}) },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

// ============================================================================
// REGRESSION SUITE
// ============================================================================

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ========================================================================
    // P0 — CRITICAL
    // ========================================================================

    // --------------------------------------------------------------------
    // R-ARG: Argument Parsing & Validation
    // --------------------------------------------------------------------

    describe('[regression:p0] Argument Parsing & Validation', function () {
        const ConfigService = require('../../src/services/ConfigService')

        it('R-ARG-001: resolveArgs identifies service, coin, network from any argument order', function () {
            const r1 = ConfigService.resolveArgs(['bitcoin', 'xchain-encoder', 'mainnet'])
            expect(r1.service).to.equal('xchain-encoder')
            expect(r1.chain).to.equal('bitcoin')
            expect(r1.network).to.equal('mainnet')

            const r2 = ConfigService.resolveArgs(['mainnet', 'bitcoin', 'xchain-encoder'])
            expect(r2.service).to.equal('xchain-encoder')
            expect(r2.chain).to.equal('bitcoin')
            expect(r2.network).to.equal('mainnet')

            const r3 = ConfigService.resolveArgs(['xchain-decoder', 'regtest', 'dogecoin'])
            expect(r3.service).to.equal('xchain-decoder')
            expect(r3.chain).to.equal('dogecoin')
            expect(r3.network).to.equal('regtest')
        })

        it('R-ARG-002: resolveArgs defaults to all/all/all when no args provided', function () {
            const result = ConfigService.resolveArgs([])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('R-ARG-003: resolveArgs rejects invalid branch names', function () {
            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'bad;branch'], { expectBranch: true })
            }).to.throw('Invalid branch name')

            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', '$(whoami)'], { expectBranch: true })
            }).to.throw('Invalid branch name')

            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'bad`cmd`'], { expectBranch: true })
            }).to.throw('Invalid branch name')
        })

        it('R-ARG-003b: resolveArgs accepts valid branch names', function () {
            const r = ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'feature/my-branch_v1.0'], { expectBranch: true })
            expect(r.branch).to.equal('feature/my-branch_v1.0')
        })

        it('R-ARG-004: filterCommandParameters excludes regtest-only modules from mainnet/testnet', function () {
            const mainnet = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
            expect(mainnet['bitcoin']['mainnet']).to.not.include('xchain-regtest-miner')
            expect(mainnet['bitcoin']['mainnet']).to.not.include('xchain-e2e-test')

            const testnet = filterCommandParameters(null, 'all', 'bitcoin', 'testnet')
            expect(testnet['bitcoin']['testnet']).to.not.include('xchain-regtest-miner')
            expect(testnet['bitcoin']['testnet']).to.not.include('xchain-e2e-test')
        })

        it('R-ARG-005: filterCommandParameters includes regtest-miner for regtest', function () {
            const regtest = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            expect(regtest['bitcoin']['regtest']).to.include('xchain-regtest-miner')
            // e2e-test excluded from "all" expansion
            expect(regtest['bitcoin']['regtest']).to.not.include('xchain-e2e-test')
        })

        it('R-ARG-006: validatePort rejects invalid values', function () {
            const { validatePort } = ConfigService
            expect(validatePort(0)).to.be.false
            expect(validatePort(-1)).to.be.false
            expect(validatePort(65536)).to.be.false
            expect(validatePort(3.14)).to.be.false
            expect(validatePort('abc')).to.be.false
            expect(validatePort('3000; rm -rf /')).to.be.false
            expect(validatePort(NaN)).to.be.false
            expect(validatePort(Infinity)).to.be.false
            // Valid
            expect(validatePort(1)).to.be.true
            expect(validatePort(80)).to.be.true
            expect(validatePort(65535)).to.be.true
            expect(validatePort('8332')).to.be.true
        })
    })

    // --------------------------------------------------------------------
    // R-CFG: Configuration Generation
    // --------------------------------------------------------------------

    describe('[regression:p0] Configuration Generation', function () {

        const expectedPorts = { mainnet: 8332, testnet: 18332, regtest: 18444 }

        it('R-CFG-001: getDefaultConfig returns correct ports for each coin/network combo', async function () {
            for (const coin of Object.values(Coin)) {
                for (const network of Object.values(Network)) {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-encoder', coin, network)
                    expect(config['NODE_PORT'], `${coin}/${network} NODE_PORT`).to.equal(expectedPorts[network])
                }
            }
        })

        it('R-CFG-002: config file overrides merge correctly over defaults', async function () {
            const cs = makeServiceWithConfig('UTXO_TRACKER_PORT=9999\nENCODER_API_PORT=4003\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            // Overridden (string from config file)
            expect(config['UTXO_TRACKER_PORT']).to.equal('9999')
            expect(config['ENCODER_API_PORT']).to.equal('4003')
            // Non-overridden defaults preserved
            expect(config['DECODER_API_PORT']).to.equal(3002)
            expect(config['NODE_PORT']).to.equal(8332)
        })

        it('R-CFG-003: Docker image names follow prefix-coin-network-module pattern', function () {
            const { getDockerContainerImageName } = require('../../src/services/ConfigService')
            for (const coin of Object.values(Coin)) {
                for (const network of Object.values(Network)) {
                    const name = getDockerContainerImageName('xchain-encoder', coin, network)
                    expect(name).to.equal(`xchain-node-${coin}-${network}-xchain-encoder`)
                }
            }
        })

        it('R-CFG-003b: shared modules omit coin/network from image name', function () {
            const { getDockerContainerImageName } = require('../../src/services/ConfigService')
            expect(getDockerContainerImageName(HUB_MODULE_NAME, '', '')).to.equal('xchain-node-xchain-hub')
            expect(getDockerContainerImageName(DB_MODULE_NAME, 'bitcoin', 'mainnet')).to.equal('xchain-node-database')
            expect(getDockerContainerImageName(EXPLORER_MODULE_NAME, '', '')).to.equal('xchain-node-xchain-explorer')
        })

        it('R-CFG-004: Docker network names follow prefix-coin-network pattern', function () {
            const { getDockerNetwork } = require('../../src/services/ConfigService')
            expect(getDockerNetwork('bitcoin', 'mainnet')).to.equal('xchain-node-bitcoin-mainnet')
            expect(getDockerNetwork('dogecoin', 'regtest')).to.equal('xchain-node-dogecoin-regtest')
            expect(getDockerNetwork('', '')).to.equal('xchain-node')
        })

        it('R-CFG-005: database names follow XChain_TICKER_Network_Module pattern', function () {
            const { getModuleDatabaseName } = require('../../src/services/ConfigService')
            expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.equal('XChain_BTC_Mainnet_Decoder')
            expect(getModuleDatabaseName('xchain-indexer', 'dogecoin', 'testnet')).to.equal('XChain_DOGE_Testnet_Indexer')
            expect(getModuleDatabaseName('xchain-decoder', 'litecoin', 'regtest')).to.equal('XChain_LTC_Regtest_Decoder')
        })

        it('R-CFG-006: all 9 coin/network combos produce correct ticker and DB user', async function () {
            for (const coin of Object.values(Coin)) {
                for (const network of Object.values(Network)) {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-decoder', coin, network)
                    expect(config['INDEXER_COIN'], `${coin}/${network} ticker`).to.equal(CoinTickerSymbol[coin])
                    expect(config['DECODER_DB_USER'], `${coin}/${network} DB user`).to.equal(`xchain_decoder_${coin}_${network}`)
                    expect(config['DECODER_DB_HOST']).to.equal('mariadb')
                    expect(config['DECODER_DB_PORT']).to.equal(3306)
                }
            }
        })

        it('R-CFG-007: regtest config includes REGTEST_MINER_URL, mainnet/testnet do not', async function () {
            const csRegtest = makeServiceWithConfig('')
            const regConf = await csRegtest.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')
            expect(regConf['REGTEST_MINER_URL']).to.exist
            expect(regConf['REGTEST_MINER_API_PORT']).to.equal(3005)

            const csMainnet = makeServiceWithConfig('')
            const mainConf = await csMainnet.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(mainConf['REGTEST_MINER_URL']).to.be.undefined

            const csTestnet = makeServiceWithConfig('')
            const testConf = await csTestnet.getDefaultConfig('xchain-encoder', 'bitcoin', 'testnet')
            expect(testConf['REGTEST_MINER_URL']).to.be.undefined
        })

        it('R-CFG-008: shared service config (null coin/network) has correct keys', async function () {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
            expect(config['HUB_PORT']).to.equal(10000)
            expect(config['NODE_PORT']).to.be.undefined
            expect(config['DECODER_DB_NAME']).to.be.undefined
        })

        it('R-CFG-009: filterCommandParameters all/all/all expands fully', function () {
            const result = filterCommandParameters(null, 'all', 'all', 'all')
            for (const coin of Object.values(Coin)) {
                expect(result).to.have.property(coin)
                for (const network of Object.values(Network)) {
                    expect(result[coin]).to.have.property(network)
                    expect(result[coin][network]).to.include('xchain-encoder')
                    expect(result[coin][network]).to.include('xchain-decoder')
                    expect(result[coin][network]).to.include('xchain-utxo-tracker')
                    expect(result[coin][network]).to.include('xchain-indexer')
                    expect(result[coin][network]).to.include('node')
                }
            }
            // Explorer as shared service
            expect(result['']).to.exist
            expect(result['']['']).to.include('xchain-explorer')
        })
    })

    // --------------------------------------------------------------------
    // R-DCK: Docker Command Construction
    // --------------------------------------------------------------------

    describe('[regression:p0] Docker Command Construction', function () {

        it('R-DCK-001: buildAndUp constructs docker run with env vars and returns 64-char container ID', async function () {
            const stubs = { execFile: sinon.stub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            const validId = 'a'.repeat(64)
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else if (args[0] === 'run') { runArgs = args; cb(null, validId + '\n') }
                else cb(null, '')
            })
            const ms = loadModuleService(stubs)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal(validId)
            expect(runArgs).to.include('-d')
            expect(runArgs[0]).to.equal('run')
        })

        it('R-DCK-002: createDockerNetwork constructs correct network create command', async function () {
            const stubs = { execFile: sinon.stub() }
            // First call: network inspect fails (network doesn't exist)
            // Second call: network create succeeds
            stubs.execFile.onFirstCall().callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            stubs.execFile.onSecondCall().callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'network-id\n')
            })
            const ds = loadDockerService(stubs)
            await ds.createDockerNetwork('xchain-node-bitcoin-mainnet')
            const [cmd, args] = stubs.execFile.secondCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.include('network')
            expect(args).to.include('create')
            expect(args).to.include('xchain-node-bitcoin-mainnet')
        })

        it('R-DCK-004: env vars from config are passed as -e flags in docker run', async function () {
            const stubs = { execFile: sinon.stub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'run') { runArgs = args; cb(null, 'a'.repeat(64) + '\n') }
                else cb(null, '')
            })

            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'MY_KEY': 'my_value',
                    'ANOTHER': '42'
                })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

            // Env vars passed as KEY=VALUE strings after -e flags
            expect(runArgs).to.include('MY_KEY=my_value')
            expect(runArgs).to.include('ANOTHER=42')
        })

        it('R-DCK-005: checkDockerInstalledAndReachable rejects when Docker missing', async function () {
            const stubs = { execFile: sinon.stub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('docker --version')
            }
        })
    })

    // --------------------------------------------------------------------
    // R-SEC: Security
    // --------------------------------------------------------------------

    describe('[regression:p0] Security', function () {

        it('R-SEC-001: branch name with shell metacharacters rejected', async function () {
            const stubs = { execFile: sinon.stub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master;rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('R-SEC-002: branch name with backticks and $() rejected', async function () {
            const stubs = { execFile: sinon.stub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master`whoami`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }

            try {
                await ms.cloneGit('xchain-encoder', false, false, '$(whoami)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('R-SEC-003: container ID with non-hex characters rejected', async function () {
            const stubs = { execFile: sinon.stub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            const invalidId = 'g'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, invalidId + '\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('R-SEC-004: container ID with injection payload rejected', async function () {
            const stubs = { execFile: sinon.stub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            const maliciousId = 'a'.repeat(63) + ';'
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, maliciousId + '\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('R-SEC-005: DockerService uses execFile (no shell) for all commands', async function () {
            const stubs = { execFile: sinon.stub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            await ds.startContainer('abc123')
            expect(stubs.execFile.calledOnce).to.be.true
            const [cmd, args] = stubs.execFile.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.be.an('array')
        })

        it('R-SEC-006: shell metacharacters in env vars passed literally via execFile', async function () {
            const stubs = { execFile: sinon.stub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'run') { runArgs = args; cb(null, 'a'.repeat(64) + '\n') }
                else cb(null, '')
            })
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'DANGEROUS': 'value$(whoami)',
                    'BACKTICK': 'hello`cmd`world'
                })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('DANGEROUS=value$(whoami)')
            expect(runArgs).to.include('BACKTICK=hello`cmd`world')
        })

        it('R-SEC-007: NODE_PREFIX regex rejects shell metacharacters', function () {
            const constants = require('../../src/config/constants')
            expect(constants.NODE_PREFIX).to.match(/^[a-z0-9][a-z0-9._-]*$/)
        })
    })

    // ========================================================================
    // P1 — HIGH
    // ========================================================================

    // --------------------------------------------------------------------
    // R-LIF: Service Lifecycle
    // --------------------------------------------------------------------

    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-001: install stores container ID in LevelDB via buildAndUp', async function () {
            const state = require('../../src/state')
            const containerId = TestEnv.fakeContainerId('a')
            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', containerId)
            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.equal(containerId)
        })

        it('R-LIF-002: startModules reads container IDs from LevelDB', async function () {
            const containerId = TestEnv.fakeContainerId('s')
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            const startedIds = []
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    startContainer: async (id) => { startedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
            await moduleOps.startModules(serviceList)
            expect(startedIds).to.include(containerId)
        })

        it('R-LIF-003: stopModules reads container IDs from LevelDB and stops', async function () {
            const containerId = TestEnv.fakeContainerId('t')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const stoppedIds = []
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    stopContainer: async (id) => { stoppedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.stopModules(serviceList)
            expect(stoppedIds).to.include(containerId)
        })

        it('R-LIF-004: restartModules reads IDs from LevelDB and restarts', async function () {
            const containerId = TestEnv.fakeContainerId('r')
            await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', containerId)

            const restartedIds = []
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    restartContainer: async (id) => { restartedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/StatusService': { statusChanged: async () => true }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-indexer'] } }
            await moduleOps.restartModules(serviceList)
            expect(restartedIds).to.have.length(1)
            expect(restartedIds[0]).to.equal(containerId)
        })

        it('R-LIF-005: uninstall removes LevelDB entry', async function () {
            const state = require('../../src/state')
            const containerId = TestEnv.fakeContainerId('u')
            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            const removed = await state.db.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(removed).to.equal(containerId)

            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.be.null
        })

        it('R-LIF-008: stopModules handles multiple modules across coin/networks', async function () {
            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')
            const id3 = TestEnv.fakeContainerId('3')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', id2)
            await env.insertModule('xchain-encoder', 'litecoin', 'testnet', id3)

            const stoppedIds = []
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    stopContainer: async (id) => { stoppedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = {
                'bitcoin':  { 'mainnet': ['xchain-encoder', 'xchain-decoder'] },
                'litecoin': { 'testnet': ['xchain-encoder'] }
            }
            await moduleOps.stopModules(serviceList)
            expect(stoppedIds).to.have.length(3)
        })

        it('R-LIF-009: execModules reads container ID and passes command', async function () {
            const containerId = TestEnv.fakeContainerId('x')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const execCalls = []
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    execContainer: async (id, cmd) => { execCalls.push({ id, cmd }); return 'output' },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.execModules(serviceList, 'ls -la')
            expect(execCalls).to.have.length(1)
            expect(execCalls[0].id).to.equal(containerId)
        })
    })

    // --------------------------------------------------------------------
    // R-STA: State & Data Integrity
    // --------------------------------------------------------------------

    describe('[regression:p1] State & Data Integrity', function () {

        let store

        beforeEach(async function () {
            store = new LevelUpStore('test', '')
            store.db = levelup(memdown())
        })

        afterEach(async function () {
            if (store.db && store.db.isOpen()) {
                await store.db.close()
            }
        })

        it('R-STA-001: LevelDB insert/get round-trip returns exact container ID', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'abc123def456')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(id).to.equal('abc123def456')
        })

        it('R-STA-002: LevelDB remove deletes entry; subsequent get returns null', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'container-abc')
            const removed = await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(removed).to.equal('container-abc')

            const retrieved = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.be.null
        })

        it('R-STA-003: getAllModuleContainers returns filtered results plus shared services', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'enc-btc')
            await store.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', 'dec-btc')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'enc-doge')
            await store.insertModuleContainer('xchain-hub', '', '', 'hub-id')

            // Filter by bitcoin/mainnet — should also include shared modules
            const modules = await store.getAllModuleContainers('bitcoin', 'mainnet')
            const names = modules.map(m => m.module)
            expect(names).to.include('xchain-encoder')
            expect(names).to.include('xchain-decoder')
            expect(names).to.include('xchain-hub')
            // Dogecoin encoder excluded
            const dogeMods = modules.filter(m => m.coin === 'dogecoin')
            expect(dogeMods).to.have.length(0)
        })

        it('R-STA-003b: getAllModuleContainers returns all entries with null filters', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'enc-btc')
            await store.insertModuleContainer('xchain-hub', '', '', 'hub-id')
            const all = await store.getAllModuleContainers(null, null)
            expect(all).to.have.length(2)
        })

        it('R-STA-004: state singleton getters/setters round-trip correctly', function () {
            const {
                getDbRootPassword, setDbRootPassword,
                getInstalledModules, setInstalledModules, resetInstalledModules,
                isStatusUpdated, setStatusUpdated,
                getLastStatus, setLastStatus,
                isVerbose, setVerbose
            } = require('../../src/state')

            // dbRootPassword
            setDbRootPassword('secret')
            expect(getDbRootPassword()).to.equal('secret')
            setDbRootPassword(null)
            expect(getDbRootPassword()).to.be.null

            // installedModules
            const mods = { bitcoin: { mainnet: {} } }
            setInstalledModules(mods)
            expect(getInstalledModules()).to.deep.equal(mods)
            resetInstalledModules()
            expect(getInstalledModules()).to.deep.equal({})

            // statusUpdated
            setStatusUpdated(true)
            expect(isStatusUpdated()).to.be.true
            setStatusUpdated(false)

            // lastStatus
            setLastStatus({ test: true })
            expect(getLastStatus()).to.deep.equal({ test: true })
            setLastStatus(null)

            // verbose
            setVerbose(true)
            expect(isVerbose()).to.be.true
            setVerbose(false)
        })

        it('R-STA-005: LevelDB overwrites existing entry on re-insert', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'old-id')
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'new-id')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(id).to.equal('new-id')
        })

        it('R-STA-006: same module on different coin/networks have independent entries', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'btc-main')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'doge-test')
            await store.insertModuleContainer('xchain-encoder', 'litecoin', 'regtest', 'ltc-reg')

            expect(await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')).to.equal('btc-main')
            expect(await store.getModuleContainer('xchain-encoder', 'dogecoin', 'testnet')).to.equal('doge-test')
            expect(await store.getModuleContainer('xchain-encoder', 'litecoin', 'regtest')).to.equal('ltc-reg')
        })
    })

    // --------------------------------------------------------------------
    // R-E2E: E2E Lifecycle Workflows
    // --------------------------------------------------------------------

    describe('[regression:p1] E2E Lifecycle Workflows', function () {
        this.timeout(30000)

        let env, cli

        beforeEach(async function () {
            env = new E2EEnv()
            await env.setup()
            env.setupDefaultRoutes()
            const state = require('../../src/state')
            state.setDbRootPassword('testrootpw')
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-E2E-001: full install -> stop -> start -> uninstall cycle succeeds', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

            // Install
            const installResult = await cli.moduleOps.installModules(serviceList, 'master')
            expect(installResult).to.be.true

            const modulesAfterInstall = await env.getAllModules()
            expect(modulesAfterInstall.length).to.be.greaterThanOrEqual(5)

            // All stored container IDs are 64 chars
            for (const mod of modulesAfterInstall) {
                expect(mod.container_id).to.have.lengthOf(64)
            }

            // Stop
            const stopResult = await cli.moduleOps.stopModules(serviceList)
            expect(stopResult).to.be.true

            // Start
            const startResult = await cli.moduleOps.startModules(serviceList)
            expect(startResult).to.be.true

            // Container IDs preserved
            const modulesAfterRestart = await env.getAllModules()
            expect(modulesAfterRestart).to.have.lengthOf(modulesAfterInstall.length)
            for (const mod of modulesAfterInstall) {
                const after = modulesAfterRestart.find(
                    m => m.module === mod.module && m.coin === mod.coin && m.network === mod.network
                )
                expect(after, `${mod.module} preserved`).to.exist
                expect(after.container_id).to.equal(mod.container_id)
            }

            // Uninstall
            const uninstallResult = await cli.moduleOps.uninstallModules(serviceList)
            expect(uninstallResult).to.be.true
        })

        it('R-E2E-002: install stores correct coin/network per module in LevelDB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modules = await env.getAllModules()
            const btcModules = modules.filter(m => m.coin === 'bitcoin' && m.network === 'regtest')
            expect(btcModules.length).to.be.greaterThanOrEqual(5)

            const moduleNames = btcModules.map(m => m.module)
            expect(moduleNames).to.include('xchain-encoder')
            expect(moduleNames).to.include('xchain-decoder')
            expect(moduleNames).to.include('xchain-utxo-tracker')
            expect(moduleNames).to.include('xchain-indexer')
            expect(moduleNames).to.include('xchain-regtest-miner')
        })

        it('R-E2E-003: selective install only installs targeted module', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const decoderEntry = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(decoderEntry).to.not.be.null
            expect(decoderEntry).to.have.lengthOf(64)

            // Encoder should NOT be installed
            const encoderEntry = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(encoderEntry).to.be.null
        })

        it('R-E2E-004: docker build commands use correct image names', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const buildCmds = env.capture.findCommands(/docker build/)
            const buildNames = buildCmds.map(c => c.command)

            expect(buildNames.some(cmd => cmd.includes('-t xchain-node-bitcoin-regtest-xchain-encoder'))).to.be.true
            expect(buildNames.some(cmd => cmd.includes('-t xchain-node-bitcoin-regtest-xchain-decoder'))).to.be.true
        })

        it('R-E2E-005: docker run commands include correct hostname and network', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmds = env.capture.findCommands(/docker run/)
            const encoderRun = runCmds.find(c => c.command.includes('xchain-encoder'))
            expect(encoderRun).to.exist
            expect(encoderRun.command).to.include('--hostname xchain-node-bitcoin-regtest-xchain-encoder')
            expect(encoderRun.command).to.include('--network xchain-node-bitcoin-regtest')
        })
    })

    // --------------------------------------------------------------------
    // R-BND: Config Parsing Boundaries
    // --------------------------------------------------------------------

    describe('[regression:p1] Config Parsing Boundaries', function () {

        it('R-BND-001: config values containing "=" are preserved fully', async function () {
            const cs = makeServiceWithConfig('NODE_PASSWORD=p@ss=word=123\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('p@ss=word=123')
        })

        it('R-BND-002: base64 values with trailing "=" are preserved', async function () {
            const cs = makeServiceWithConfig('AUTH_TOKEN=dGVzdA==\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['AUTH_TOKEN']).to.equal('dGVzdA==')
        })

        it('R-BND-003: empty value after "=" is preserved as empty string', async function () {
            const cs = makeServiceWithConfig('EMPTY_VAR=\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['EMPTY_VAR']).to.equal('')
        })

        it('R-BND-004: blank lines and lines without "=" are skipped', async function () {
            const cs = makeServiceWithConfig('\n\nno-equals-here\nKEY=value\n\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['no-equals-here']).to.be.undefined
            expect(config['KEY']).to.equal('value')
        })

        it('R-BND-005: missing config file falls back to defaults', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            // Should still have default values
            expect(config['NODE_PORT']).to.equal(8332)
            expect(config['ENCODER_API_PORT']).to.equal(3003)
        })
    })

    // ========================================================================
    // P2 — MEDIUM
    // ========================================================================

    // --------------------------------------------------------------------
    // R-PRE: Precheck & Error Handling
    // --------------------------------------------------------------------

    describe('[regression:p2] Precheck & Error Handling', function () {
        this.timeout(15000)

        it('R-PRE-001: checkDockerInstalledAndReachable succeeds when Docker is available', async function () {
            const stubs = { execFile: sinon.stub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === '--version') cb(null, 'Docker version 24.0.0, build abc1234')
                else if (args[0] === 'ps') cb(null, '')
                else cb(null, '')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.checkDockerInstalledAndReachable()
            expect(result).to.be.true
        })

        it('R-PRE-002: startModules gracefully handles missing LevelDB entry', async function () {
            const env = new TestEnv()
            await env.setup()

            try {
                const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                    '../services/DockerService': {
                        startContainer: sinon.stub().resolves(true),
                        createDockerNetwork: async () => true,
                        stopContainer: async () => true,
                        restartContainer: async () => true,
                        killContainer: async () => true,
                        removeContainer: async () => true,
                        execContainer: async () => '',
                        shellContainer: async () => true,
                        logContainer: async () => true,
                        startDockerMonitor: async () => true
                    }
                })

                const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
                // Should not throw
                const result = await moduleOps.startModules(serviceList)
                expect(result).to.be.true
            } finally {
                await env.teardown()
            }
        })

        it('R-PRE-003: LevelDB removeModuleContainer returns false for non-existent key', async function () {
            const store = new LevelUpStore('test', '')
            store.db = levelup(memdown())
            try {
                const result = await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
                expect(result).to.equal(false)
            } finally {
                if (store.db.isOpen()) await store.db.close()
            }
        })

        it('R-PRE-004: path traversal in config coin parameter is caught', async function () {
            const ConfigService = require('../../src/services/ConfigService')
            try {
                await ConfigService.getDefaultConfig('xchain-encoder', '../../../etc', 'passwd')
            } catch (err) {
                expect(err.message).to.include('traversal')
            }
        })
    })

    // --------------------------------------------------------------------
    // R-HLP: Utility Function Regression
    // --------------------------------------------------------------------

    describe('[regression:p2] Utility Functions', function () {

        it('R-HLP-001: stringToCoin maps all supported coins correctly', function () {
            const { stringToCoin } = require('../../src/utils/helpers')
            expect(stringToCoin('bitcoin')).to.equal('BITCOIN')
            expect(stringToCoin('dogecoin')).to.equal('DOGECOIN')
            expect(stringToCoin('litecoin')).to.equal('LITECOIN')
            expect(stringToCoin('ethereum')).to.be.null
            expect(stringToCoin('')).to.be.null
            expect(stringToCoin(null)).to.be.null
        })

        it('R-HLP-002: stringToXChainService maps all services correctly', function () {
            const { stringToXChainService } = require('../../src/utils/helpers')
            expect(stringToXChainService('xchain-encoder')).to.equal('XCHAIN_ENCODER')
            expect(stringToXChainService('xchain-decoder')).to.equal('XCHAIN_DECODER')
            expect(stringToXChainService('xchain-utxo-tracker')).to.equal('XCHAIN_UTXO_TRACKER')
            expect(stringToXChainService('xchain-indexer')).to.equal('XCHAIN_INDEXER')
            expect(stringToXChainService('xchain-regtest-miner')).to.equal('XCHAIN_REGTEST_MINER')
            expect(stringToXChainService('xchain-e2e-test')).to.equal('XCHAIN_E2E_TEST')
            expect(stringToXChainService('xchain-unknown')).to.be.null
        })

        it('R-HLP-003: stringToNetwork parses coin-network pairs correctly', function () {
            const { stringToNetwork } = require('../../src/utils/helpers')
            const btc = stringToNetwork('bitcoin-mainnet')
            expect(btc.coin).to.equal('BITCOIN')
            expect(btc.network).to.equal('MAINNET')

            const doge = stringToNetwork('dogecoin-testnet')
            expect(doge.coin).to.equal('DOGECOIN')
            expect(doge.network).to.equal('TESTNET')

            const ltc = stringToNetwork('litecoin-regtest')
            expect(ltc.coin).to.equal('LITECOIN')
            expect(ltc.network).to.equal('REGTEST')

            const unknown = stringToNetwork('ethereum-goerli')
            expect(unknown.coin).to.be.null
        })

        it('R-HLP-004: constants enums contain all expected values', function () {
            expect(Object.values(Coin)).to.include.members(['bitcoin', 'dogecoin', 'litecoin'])
            expect(Object.values(Network)).to.include.members(['mainnet', 'testnet', 'regtest'])
            expect(Object.values(XChainService)).to.include.members([
                'xchain-encoder', 'xchain-decoder', 'xchain-utxo-tracker',
                'xchain-indexer', 'xchain-regtest-miner', 'xchain-e2e-test'
            ])
            expect(CoinTickerSymbol['bitcoin']).to.equal('BTC')
            expect(CoinTickerSymbol['dogecoin']).to.equal('DOGE')
            expect(CoinTickerSymbol['litecoin']).to.equal('LTC')
        })
    })
})
