'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const fs         = require('fs')

const ROOT = path.join(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// S-SMOKE-001: Module Import Chain
// ---------------------------------------------------------------------------

describe('S-SMOKE-001 – Module Import Chain', function () {

    // Modules that can be required with zero side-effects
    const safeDirect = {
        'config/constants':   'src/config/constants.js',
        'utils/helpers':      'src/utils/helpers.js',
        'MariaDbStore':       'src/MariaDbStore.js',
        'HubConnector':       'src/HubConnector.js',
        'ExplorerConnector':  'src/ExplorerConnector.js'
    }

    for (const [label, relPath] of Object.entries(safeDirect)) {
        it(`requires ${label} without throwing`, function () {
            const mod = require(path.join(ROOT, relPath))
            expect(mod).to.not.be.null
            expect(mod).to.not.be.undefined
        })
    }

    // Modules that need child_process / fs / blessed / leveldb stubbed
    it('requires ConfigService without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/services/ConfigService'), {
            'fs': {
                existsSync: sinon.stub().returns(false),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createReadStream: sinon.stub()
            }
        })
        expect(mod).to.have.property('getDefaultConfig').that.is.a('function')
        expect(mod).to.have.property('filterCommandParameters').that.is.a('function')
        expect(mod).to.have.property('resolveArgs').that.is.a('function')
    })

    it('requires DockerService without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/services/DockerService'), {
            'child_process': {
                execFile: sinon.stub(),
                spawn: sinon.stub(),
                spawnSync: sinon.stub()
            },
            'util': { promisify: (fn) => fn },
            'fs': { readFileSync: sinon.stub(), mkdirSync: sinon.stub() },
            'blessed': {
                screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
                text: sinon.stub(),
                log: sinon.stub().returns({ log: sinon.stub() })
            }
        })
        expect(mod).to.have.property('checkDockerInstalledAndReachable').that.is.a('function')
        expect(mod).to.have.property('createDockerNetwork').that.is.a('function')
    })

    it('requires GitHubDownloader without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/GitHubDownloader'), {
            'fs': {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns('{}'),
                writeFileSync: sinon.stub(),
                readdirSync: sinon.stub().returns([]),
                statSync: sinon.stub().returns({ isFile: () => false, isDirectory: () => false })
            }
        })
        expect(mod).to.be.a('function') // class constructor
    })

    it('requires state module without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/state'), {
            './MariaDbStore.js': function StubMariaDbStore() {
                this.createDatabase = sinon.stub().resolves()
                this.isReady = sinon.stub().returns(false)
            },
            './GitHubDownloader.js': function StubGitHubDownloader() {
                this.loadHashesFile = sinon.stub().returns({})
            }
        })
        expect(mod).to.have.property('db')
        expect(mod).to.have.property('gitHubDownloader')
        expect(mod).to.have.property('setVerbose').that.is.a('function')
    })

    it('requires precheck without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/precheck'), {
            './state': {
                db: { createDatabase: sinon.stub().resolves() },
                isVerbose: sinon.stub().returns(false)
            },
            './services/DockerService': {
                checkDockerInstalledAndReachable: sinon.stub().resolves(true),
                createDockerNetwork: sinon.stub().resolves(true)
            },
            './services/ConfigService': {
                getDockerNetwork: sinon.stub().returns('xchain-node')
            },
            './services/VersionService': {
                checkAllRemoteVersions: sinon.stub().resolves()
            },
            './services/StatusService': {
                getStatus: sinon.stub().resolves()
            },
            './services/HubService': {
                installHubModule: sinon.stub().resolves(),
                updateHub: sinon.stub().resolves()
            },
            './services/ExplorerService': {
                updateExplorer: sinon.stub().resolves()
            }
        })
        expect(mod).to.have.property('preCheck').that.is.a('function')
    })

    it('requires moduleOperations without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/operations/moduleOperations'), {
            '../state': {
                db: { getAllModuleContainers: sinon.stub().resolves([]), insertModuleContainer: sinon.stub().resolves() },
                getInstalledModules: sinon.stub().returns({}),
                setInstalledModules: sinon.stub(),
                resetInstalledModules: sinon.stub(),
                getDbRootPassword: sinon.stub().returns(null),
                setDbRootPassword: sinon.stub(),
                isVerbose: sinon.stub().returns(false)
            },
            '../services/ConfigService': {
                getModuleDir: sinon.stub(),
                getModuleTmpDir: sinon.stub(),
                moduleDirExists: sinon.stub(),
                checkIfModuleExists: sinon.stub(),
                removeModuleDir: sinon.stub(),
                removeModuleTmpDir: sinon.stub(),
                createModuleTmpDir: sinon.stub(),
                getDockerContainerImageName: sinon.stub(),
                getDockerNetwork: sinon.stub(),
                getDefaultConfig: sinon.stub().resolves({}),
                getCryptoNodeDir: sinon.stub(),
                checkIfCryptoNodeSourceExists: sinon.stub(),
                filterCommandParameters: sinon.stub(),
                getDockerContainerImageNamePrefix: sinon.stub(),
                getModuleDatabaseName: sinon.stub()
            },
            '../services/DockerService': {
                checkDockerInstalledAndReachable: sinon.stub().resolves(true),
                createDockerNetwork: sinon.stub().resolves(true),
                stopContainer: sinon.stub().resolves(),
                startContainer: sinon.stub().resolves(),
                restartContainer: sinon.stub().resolves(),
                killContainer: sinon.stub().resolves(),
                removeContainer: sinon.stub().resolves(),
                execContainer: sinon.stub().resolves(),
                shellContainer: sinon.stub().resolves(),
                logContainer: sinon.stub().resolves(),
                startDockerMonitor: sinon.stub().resolves(),
                addContainerToNetwork: sinon.stub().resolves(),
                saveContainerLogs: sinon.stub().resolves(),
                waitContainer: sinon.stub().resolves()
            },
            '../services/ModuleService': {
                cloneGit: sinon.stub().resolves(),
                buildAndUp: sinon.stub().resolves(),
                installModule: sinon.stub().resolves(),
                uninstallModule: sinon.stub().resolves()
            },
            '../services/StatusService': {
                getStatus: sinon.stub().resolves(),
                statusChanged: sinon.stub().resolves()
            },
            '../services/DatabaseService': {
                setDatabaseParameters: sinon.stub().resolves(),
                createDatabase: sinon.stub().resolves(),
                dropDatabase: sinon.stub().resolves()
            },
            '../services/HubService': {
                installHubModule: sinon.stub().resolves(),
                updateHub: sinon.stub().resolves()
            },
            '../services/BootstrapService': {
                makeBootstrap: sinon.stub().resolves(),
                restoreBootstrap: sinon.stub().resolves()
            }
        })
        expect(mod).to.have.property('installModules').that.is.a('function')
        expect(mod).to.have.property('startModules').that.is.a('function')
        expect(mod).to.have.property('stopModules').that.is.a('function')
    })
})

// ---------------------------------------------------------------------------
// S-SMOKE-002: Commander CLI Registration
// ---------------------------------------------------------------------------

describe('S-SMOKE-002 – Commander CLI Registration', function () {

    let program

    before(function () {
        // Intercept Commander to capture the program instance
        const { Command } = require('commander')
        const capturedProgram = new Command()
        let originalParse = capturedProgram.parse

        const mod = proxyquire(path.join(ROOT, 'src/cli'), {
            'commander': {
                Command: function () {
                    // Stub parse to prevent actual argv processing
                    capturedProgram.parse = sinon.stub()
                    return capturedProgram
                }
            },
            './precheck': { preCheck: sinon.stub().resolves() },
            './state': { setVerbose: sinon.stub() },
            './services/ConfigService': {
                filterCommandParameters: sinon.stub().returns({}),
                resolveArgs: sinon.stub().returns({ service: 'all', chain: 'all', network: 'all', branch: 'master' })
            },
            './operations/moduleOperations': {
                installModules: sinon.stub().resolves(),
                updateModules: sinon.stub().resolves(),
                uninstallModules: sinon.stub().resolves(),
                logModules: sinon.stub().resolves(),
                monitorModules: sinon.stub().resolves(),
                restartModules: sinon.stub().resolves(),
                stopModules: sinon.stub().resolves(),
                startModules: sinon.stub().resolves(),
                execModules: sinon.stub().resolves(),
                shellModule: sinon.stub().resolves(),
                runE2ETest: sinon.stub().resolves({ logFile: '', exitCode: 0 }),
                resetModules: sinon.stub().resolves()
            },
            './services/StatusService': { getStatus: sinon.stub().resolves() },
            './services/BootstrapService': { makeBootstrap: sinon.stub().resolves() },
            './ui/menu': {
                restoreBootstrapInterface: sinon.stub().resolves(),
                startInterface: sinon.stub().resolves()
            }
        })

        // Invoke parseCommand to trigger all program.command() registrations
        mod.parseCommand()

        program = capturedProgram
    })

    const expectedCommands = [
        'install', 'uninstall', 'update', 'ps',
        'start', 'stop', 'restart',
        'tail', 'logs', 'monitor', 'tailmonitor',
        'exec', 'shell', 'e2etest', 'reset', 'rollback', 'bootstrap'
    ]

    it('registers all expected commands', function () {
        const registeredNames = program.commands.map(c => c.name())
        for (const name of expectedCommands) {
            expect(registeredNames, `missing command: ${name}`).to.include(name)
        }
    })

    it('each command has an action handler', function () {
        for (const cmd of program.commands) {
            expect(cmd._actionHandler, `${cmd.name()} missing action handler`).to.be.a('function')
        }
    })

    // Argument counts per command
    const expectedArgs = {
        'install':     { required: 2, optional: 2 },
        'uninstall':   { required: 1, optional: 2 },
        'update':      { required: 1, optional: 3 },
        'ps':          { required: 0, optional: 0 },
        'start':       { required: 1, optional: 2 },
        'stop':        { required: 1, optional: 2 },
        'restart':     { required: 1, optional: 2 },
        'tail':        { required: 0, optional: 3 },
        'logs':        { required: 0, optional: 3 },
        'monitor':     { required: 0, optional: 3 },
        'tailmonitor': { required: 0, optional: 3 },
        'exec':        { required: 4, optional: 0 },
        'shell':       { required: 3, optional: 0 },
        'e2etest':     { required: 1, optional: 1 },
        'reset':       { required: 3, optional: 0 },
        'rollback':    { required: 4, optional: 0 },
        'bootstrap':   { required: 4, optional: 0 }
    }

    for (const [cmdName, counts] of Object.entries(expectedArgs)) {
        it(`${cmdName} has correct argument counts (${counts.required} required, ${counts.optional} optional)`, function () {
            const cmd = program.commands.find(c => c.name() === cmdName)
            expect(cmd, `command ${cmdName} not found`).to.exist

            const args = cmd.registeredArguments || cmd._args || []
            const required = args.filter(a => a.required).length
            const optional = args.filter(a => !a.required).length

            expect(required, `${cmdName} required args`).to.equal(counts.required)
            expect(optional, `${cmdName} optional args`).to.equal(counts.optional)
        })
    }
})

// ---------------------------------------------------------------------------
// S-SMOKE-003: Global Options Registration
// ---------------------------------------------------------------------------

describe('S-SMOKE-003 – Global Options Registration', function () {

    let program

    before(function () {
        const { Command } = require('commander')
        const capturedProgram = new Command()

        proxyquire(path.join(ROOT, 'src/cli'), {
            'commander': {
                Command: function () {
                    capturedProgram.parse = sinon.stub()
                    return capturedProgram
                }
            },
            './precheck': { preCheck: sinon.stub().resolves() },
            './state': { setVerbose: sinon.stub() },
            './services/ConfigService': {
                filterCommandParameters: sinon.stub().returns({}),
                resolveArgs: sinon.stub().returns({ service: 'all', chain: 'all', network: 'all', branch: 'master' })
            },
            './operations/moduleOperations': {
                installModules: sinon.stub().resolves(),
                updateModules: sinon.stub().resolves(),
                uninstallModules: sinon.stub().resolves(),
                logModules: sinon.stub().resolves(),
                monitorModules: sinon.stub().resolves(),
                restartModules: sinon.stub().resolves(),
                stopModules: sinon.stub().resolves(),
                startModules: sinon.stub().resolves(),
                execModules: sinon.stub().resolves(),
                shellModule: sinon.stub().resolves(),
                runE2ETest: sinon.stub().resolves({ logFile: '', exitCode: 0 }),
                resetModules: sinon.stub().resolves()
            },
            './services/StatusService': { getStatus: sinon.stub().resolves() },
            './services/BootstrapService': { makeBootstrap: sinon.stub().resolves() },
            './ui/menu': {
                restoreBootstrapInterface: sinon.stub().resolves(),
                startInterface: sinon.stub().resolves()
            }
        }).parseCommand()

        program = capturedProgram
    })

    const expectedOptions = [
        { flags: '--verbose',       short: '-v' },
        { flags: '--interactive',   short: '-i' },
        { flags: '--no-bootstrap',  short: null },
        { flags: '--no-explorer',   short: null },
        { flags: '--version',       short: '-V' }
    ]

    for (const opt of expectedOptions) {
        it(`registers ${opt.flags} option`, function () {
            const found = program.options.some(o => o.long === opt.flags)
            expect(found, `missing option ${opt.flags}`).to.be.true
        })

        if (opt.short) {
            it(`registers ${opt.short} as short flag for ${opt.flags}`, function () {
                const found = program.options.some(o => o.short === opt.short && o.long === opt.flags)
                expect(found, `missing short flag ${opt.short}`).to.be.true
            })
        }
    }
})

// ---------------------------------------------------------------------------
// S-SMOKE-004: Constants and Enum Integrity
// ---------------------------------------------------------------------------

describe('S-SMOKE-004 – Constants and Enum Integrity', function () {

    const constants = require(path.join(ROOT, 'src/config/constants'))

    describe('XChainService enum', function () {
        const expectedServices = [
            'xchain-encoder', 'xchain-decoder', 'xchain-utxo-tracker',
            'xchain-regtest-miner', 'xchain-indexer', 'xchain-e2e-test'
        ]

        for (const svc of expectedServices) {
            it(`contains ${svc}`, function () {
                expect(Object.values(constants.XChainService)).to.include(svc)
            })
        }
    })

    describe('Coin enum', function () {
        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            it(`contains ${coin}`, function () {
                expect(Object.values(constants.Coin)).to.include(coin)
            })
        }
    })

    describe('Network enum', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            it(`contains ${net}`, function () {
                expect(Object.values(constants.Network)).to.include(net)
            })
        }
    })

    describe('CoinTickerSymbol', function () {
        it('maps bitcoin to BTC', function () {
            expect(constants.CoinTickerSymbol['bitcoin']).to.equal('BTC')
        })
        it('maps litecoin to LTC', function () {
            expect(constants.CoinTickerSymbol['litecoin']).to.equal('LTC')
        })
        it('maps dogecoin to DOGE', function () {
            expect(constants.CoinTickerSymbol['dogecoin']).to.equal('DOGE')
        })
    })

    describe('Directory path constants', function () {
        const pathConstants = ['moduleDir', 'tmpDir', 'srcDir', 'cryptoNodesDir', 'dataDir', 'configDir', 'containersFilesDir']

        for (const name of pathConstants) {
            it(`${name} is a non-empty string`, function () {
                expect(constants[name]).to.be.a('string').that.is.not.empty
            })
        }
    })

    describe('String constants', function () {
        it('NODE_PREFIX is defined', function () {
            expect(constants.NODE_PREFIX).to.be.a('string').that.is.not.empty
        })
        it('HUB_PORT is a number', function () {
            expect(constants.HUB_PORT).to.be.a('number')
        })
        it('SEP is defined', function () {
            expect(constants.SEP).to.be.a('string').that.is.not.empty
        })
        it('DB_SEP is defined', function () {
            expect(constants.DB_SEP).to.be.a('string').that.is.not.empty
        })
    })

    describe('modulesUrls mapping', function () {
        const allModules = [
            ...Object.values(constants.XChainService),
            constants.HUB_MODULE_NAME,
            constants.EXPLORER_MODULE_NAME,
            constants.INDEXER_SYNC_MODULE_NAME
        ]

        for (const mod of allModules) {
            it(`has git URL for ${mod}`, function () {
                expect(constants.modulesUrls[mod]).to.be.a('string').that.includes('git')
            })
        }
    })

    describe('projectFolders mapping', function () {
        const allModules = [
            ...Object.values(constants.XChainService),
            constants.HUB_MODULE_NAME,
            constants.EXPLORER_MODULE_NAME,
            constants.INDEXER_SYNC_MODULE_NAME
        ]

        for (const mod of allModules) {
            it(`has project folder for ${mod}`, function () {
                expect(constants.projectFolders[mod]).to.be.a('string').that.is.not.empty
            })
        }
    })

    describe('REGTEST_MODULES', function () {
        it('includes xchain-regtest-miner', function () {
            expect(constants.REGTEST_MODULES).to.include('xchain-regtest-miner')
        })
        it('includes xchain-e2e-test', function () {
            expect(constants.REGTEST_MODULES).to.include('xchain-e2e-test')
        })
        it('does not include non-regtest services', function () {
            expect(constants.REGTEST_MODULES).to.not.include('xchain-encoder')
            expect(constants.REGTEST_MODULES).to.not.include('xchain-decoder')
        })
    })
})

// ---------------------------------------------------------------------------
// S-SMOKE-005: Config Template File Integrity
// ---------------------------------------------------------------------------

describe('S-SMOKE-005 – Config Template File Integrity', function () {

    const configDir = path.join(ROOT, 'config')

    const coins = ['bitcoin', 'litecoin', 'dogecoin']
    const networks = ['mainnet', 'testnet', 'regtest']
    const requiredKeys = ['NETWORK', 'NODE_EXPOSED_PORT', 'DUST_AMOUNT']

    for (const coin of coins) {
        for (const network of networks) {
            const fileName = `${coin}-${network}`

            describe(fileName, function () {

                let content, lines

                before(function () {
                    const filePath = path.join(configDir, fileName)
                    expect(fs.existsSync(filePath), `${fileName} does not exist`).to.be.true
                    content = fs.readFileSync(filePath, 'utf8')
                    lines = content.split('\n').filter(l => l.trim() !== '')
                })

                it('is non-empty', function () {
                    expect(content.trim()).to.not.be.empty
                })

                it('all lines match KEY=VALUE format', function () {
                    for (const line of lines) {
                        expect(line, `malformed line: "${line}"`).to.match(/^[A-Z_]+=.+$/)
                    }
                })

                for (const key of requiredKeys) {
                    it(`contains ${key}`, function () {
                        const hasKey = lines.some(l => l.startsWith(key + '='))
                        expect(hasKey, `missing key: ${key}`).to.be.true
                    })
                }

                it('has no duplicate keys', function () {
                    const keys = lines.map(l => l.split('=')[0])
                    const unique = new Set(keys)
                    expect(keys.length, 'duplicate keys found').to.equal(unique.size)
                })
            })
        }
    }
})

// ---------------------------------------------------------------------------
// S-SMOKE-006: Config Composition (getDefaultConfig)
// ---------------------------------------------------------------------------

describe('S-SMOKE-006 – Config Composition', function () {

    const ConfigService = require(path.join(ROOT, 'src/services/ConfigService'))

    it('getDefaultConfig returns populated config for bitcoin/mainnet', async function () {
        const config = await ConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')

        // From template file
        expect(config).to.have.property('NETWORK', 'bitcoin-mainnet')
        expect(config).to.have.property('NODE_EXPOSED_PORT')
        expect(config).to.have.property('DUST_AMOUNT')

        // From computed defaults
        expect(config).to.have.property('DECODER_DB_NAME').that.includes('BTC')
        expect(config).to.have.property('DECODER_DB_HOST')
        expect(config).to.have.property('INDEXER_DB_NAME').that.includes('BTC')
        expect(config).to.have.property('INDEXER_DB_USER').that.includes('bitcoin')
        expect(config).to.have.property('HUB_PORT', 10000)
        expect(config).to.have.property('NODE_URL')
        expect(config).to.have.property('UTXO_TRACKER_URL').that.is.a('string').that.is.not.empty

        // No undefined values for critical keys
        const criticalKeys = ['NETWORK', 'DECODER_DB_NAME', 'INDEXER_DB_NAME', 'HUB_PORT', 'NODE_URL']
        for (const key of criticalKeys) {
            expect(config[key], `${key} is undefined`).to.not.be.undefined
        }
    })

    it('getDefaultConfig returns regtest-specific values for bitcoin/regtest', async function () {
        const config = await ConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')

        expect(config).to.have.property('NETWORK', 'bitcoin-regtest')
        expect(config).to.have.property('REGTEST_MINER_URL').that.is.a('string')
        expect(config).to.have.property('REGTEST_MINER_PORT')
    })

    it('getDefaultConfig returns shared-service config when coin/network are omitted', async function () {
        const config = await ConfigService.getDefaultConfig('xchain-hub', null, null)

        expect(config).to.have.property('HUB_PORT', 10000)
        expect(config).to.have.property('EXPLORER_PORT_HTTP')
        expect(config).to.have.property('SYNC_MODE')
    })
})

// ---------------------------------------------------------------------------
// S-SMOKE-007: Docker Command Construction
// ---------------------------------------------------------------------------

describe('S-SMOKE-007 – Docker Command Construction', function () {

    const DockerService = proxyquire(path.join(ROOT, 'src/services/DockerService'), {
        'child_process': {
            execFile: sinon.stub(),
            spawn: sinon.stub(),
            spawnSync: sinon.stub()
        },
        'util': { promisify: (fn) => fn },
        'fs': {
            readFileSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub().returns({ end: sinon.stub() })
        },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })

    it('exports all expected Docker operation functions', function () {
        const expectedFunctions = [
            'checkDockerInstalledAndReachable',
            'getStatusFromContainer',
            'createDockerNetwork',
            'addContainerToNetwork',
            'stopContainer',
            'startContainer',
            'restartContainer',
            'removeContainer',
            'killContainer',
            'execContainer',
            'shellContainer',
            'logContainer',
            'startDockerMonitor',
            'saveContainerLogs',
            'waitContainer'
        ]

        for (const fn of expectedFunctions) {
            expect(DockerService, `missing function: ${fn}`).to.have.property(fn).that.is.a('function')
        }
    })
})

// ---------------------------------------------------------------------------
// S-SMOKE-008: Parameter Expansion (filterCommandParameters)
// ---------------------------------------------------------------------------

describe('S-SMOKE-008 – Parameter Expansion', function () {

    const { filterCommandParameters } = require(path.join(ROOT, 'src/services/ConfigService'))

    it('expands all/bitcoin/mainnet to all non-regtest services', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')

        expect(result).to.have.property('bitcoin')
        expect(result.bitcoin).to.have.property('mainnet').that.is.an('array')

        const services = result.bitcoin.mainnet
        expect(services).to.include('xchain-encoder')
        expect(services).to.include('xchain-decoder')
        expect(services).to.include('xchain-utxo-tracker')
        expect(services).to.include('xchain-indexer')
        expect(services).to.include('node')
        expect(services).to.not.include('xchain-regtest-miner')
        expect(services).to.not.include('xchain-e2e-test')
    })

    it('expands all/bitcoin/regtest to include regtest-only modules', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

        expect(result.bitcoin.regtest).to.include('xchain-regtest-miner')
    })

    it('expands single service across all coins and networks', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'all', 'all')

        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            expect(result).to.have.property(coin)
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                expect(result[coin]).to.have.property(network)
                expect(result[coin][network]).to.include('xchain-encoder')
                expect(result[coin][network]).to.have.lengthOf(1)
            }
        }
    })

    it('filters regtest-only modules from non-regtest networks', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')

        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            expect(result[coin].mainnet).to.not.include('xchain-regtest-miner')
            expect(result[coin].testnet).to.not.include('xchain-regtest-miner')
            expect(result[coin].mainnet).to.not.include('xchain-e2e-test')
            expect(result[coin].testnet).to.not.include('xchain-e2e-test')
            // regtest should have it
            expect(result[coin].regtest).to.include('xchain-regtest-miner')
        }
    })

    it('adds explorer as shared service when using all', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')

        expect(result).to.have.property('')
        expect(result['']).to.have.property('')
        expect(result['']['']).to.include('xchain-explorer')
    })
})

// ---------------------------------------------------------------------------
// S-SMOKE-009: State Module Initialization
// ---------------------------------------------------------------------------

describe('S-SMOKE-009 – State Module Initialization', function () {

    const state = proxyquire(path.join(ROOT, 'src/state'), {
        './MariaDbStore.js': function StubMariaDbStore() {
            this.createDatabase = sinon.stub().resolves()
            this.isReady = sinon.stub().returns(false)
        },
        './GitHubDownloader.js': function StubGitHubDownloader() {
            this.loadHashesFile = sinon.stub().returns({})
        }
    })

    it('exports db instance', function () {
        expect(state.db).to.be.an('object')
    })

    it('exports gitHubDownloader instance', function () {
        expect(state.gitHubDownloader).to.be.an('object')
    })

    it('getInstalledModules returns empty object initially', function () {
        expect(state.getInstalledModules()).to.deep.equal({})
    })

    it('getRemoteModuleVersions returns empty object initially', function () {
        expect(state.getRemoteModuleVersions()).to.deep.equal({})
    })

    it('isVerbose returns false initially', function () {
        expect(state.isVerbose()).to.be.false
    })

    it('getDbRootPassword returns null initially', function () {
        expect(state.getDbRootPassword()).to.be.null
    })

    it('setVerbose and isVerbose work as getter/setter', function () {
        state.setVerbose(true)
        expect(state.isVerbose()).to.be.true
        state.setVerbose(false)
        expect(state.isVerbose()).to.be.false
    })

    it('exports all expected getter/setter functions', function () {
        const expectedFns = [
            'getDbRootPassword', 'setDbRootPassword',
            'getInstalledModules', 'setInstalledModules', 'resetInstalledModules',
            'getRemoteModuleVersions', 'setRemoteModuleVersion',
            'isStatusUpdated', 'setStatusUpdated',
            'getLastStatus', 'setLastStatus',
            'getLastPrintedStatus', 'setLastPrintedStatus', 'appendLastPrintedStatus',
            'isVerbose', 'setVerbose'
        ]

        for (const fn of expectedFns) {
            expect(state, `missing export: ${fn}`).to.have.property(fn).that.is.a('function')
        }
    })
})

// ---------------------------------------------------------------------------
// S-SMOKE-010: Crypto Node Dockerfile Existence
// ---------------------------------------------------------------------------

describe('S-SMOKE-010 – Crypto Node Dockerfile Existence', function () {

    const cryptoNodesDir = path.join(ROOT, 'crypto_nodes')

    for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
        it(`${coin}/Dockerfile exists and is non-empty`, function () {
            const dockerfilePath = path.join(cryptoNodesDir, coin, 'Dockerfile')
            expect(fs.existsSync(dockerfilePath), `${coin}/Dockerfile missing`).to.be.true

            const content = fs.readFileSync(dockerfilePath, 'utf8')
            expect(content.trim(), `${coin}/Dockerfile is empty`).to.not.be.empty
        })
    }
})
