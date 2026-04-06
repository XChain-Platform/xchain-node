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
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, configDir
} = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
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

function makeModuleServiceStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            insertModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves('old-container-id'),
            removeModuleContainer: sinon.stub().resolves('removed-id')
        },
        statusChanged: sinon.stub().resolves(),
        getStatus: sinon.stub().resolves({}),
        killContainer: sinon.stub().resolves(true),
        removeContainer: sinon.stub().resolves(true)
    }
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
        getDockerNetwork: (c, n) => `xchain-node-${c}-${n}`,
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'bitcoin-mainnet',
            'DECODER_PORT': 3002,
            'DECODER_API_PORT': 3002
        })
    }, configOverrides || {})

    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getLastStatus: () => null,
            getRemoteModuleVersions: () => ({})
        },
        './ConfigService': configServiceStub,
        './StatusService': {
            statusChanged: stubs.statusChanged,
            getStatus: stubs.getStatus
        },
        './DockerService': {
            killContainer: stubs.killContainer,
            removeContainer: stubs.removeContainer
        },
        './DatabaseService': {
            setDatabaseParameters: sinon.stub().resolves()
        }
    })
}

describe('Boundary Tests', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ===================================================================
    // 1. Config file parsing boundaries (Fix 1 & 2)
    // ===================================================================

    describe('ConfigService — config file parsing', function () {

        describe('values containing "=" (Fix 1)', function () {

            it('preserves full value when it contains "="', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('NODE_PASSWORD=p@ss=word=123\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['NODE_PASSWORD']).to.equal('p@ss=word=123')
            })

            it('handles base64-encoded values with trailing "="', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('AUTH_TOKEN=dGVzdA==\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['AUTH_TOKEN']).to.equal('dGVzdA==')
            })

            it('handles value that is just "="', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('SEPARATOR==\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['SEPARATOR']).to.equal('=')
            })
        })

        describe('empty and blank config values', function () {

            it('handles empty value after "="', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('EMPTY_VAR=\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['EMPTY_VAR']).to.equal('')
            })

            it('skips blank lines', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('\n\nKEY=value\n\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['KEY']).to.equal('value')
            })

            it('skips lines without "="', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('no-equals-here\nKEY=value\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['no-equals-here']).to.be.undefined
                expect(config['KEY']).to.equal('value')
            })

            it('skips lines that start with "=" (no key)', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('=nokey\nKEY=value\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['']).to.be.undefined
                expect(config['KEY']).to.equal('value')
            })
        })

        describe('missing config file (Fix 2)', function () {

            it('falls back to defaults when config file does not exist', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(false),
                    createReadStream: sinon.stub(),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

                // Should have defaults, not crash
                expect(config['NODE_PORT']).to.equal(8332)
                expect(config['NODE_USER']).to.equal('rpc')
                expect(config['HUB_PORT']).to.equal(10000)

                // createReadStream should NOT have been called
                expect(fsStub.createReadStream.called).to.be.false
            })

            it('does not attempt file read for shared services (null coin/network)', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(false),
                    createReadStream: sinon.stub(),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
                expect(config['HUB_PORT']).to.equal(10000)
                expect(fsStub.createReadStream.called).to.be.false
            })
        })

        describe('config file value override priority', function () {

            it('config file values override hardcoded defaults', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('NODE_PORT=9999\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['NODE_PORT']).to.equal('9999')
            })

            it('hardcoded defaults fill in for keys not in config file', async function () {
                const fsStub = {
                    existsSync: sinon.stub().returns(true),
                    createReadStream: sinon.stub().returns(streamFromString('CUSTOM_KEY=custom\n')),
                    rmSync: sinon.stub(),
                    mkdirSync: sinon.stub()
                }
                const cs = makeConfigService(fsStub)
                const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect(config['CUSTOM_KEY']).to.equal('custom')
                expect(config['NODE_PORT']).to.equal(8332)
            })
        })
    })

    // ===================================================================
    // 2. resolveArgs boundaries
    // ===================================================================

    describe('ConfigService — resolveArgs boundaries', function () {
        const { resolveArgs } = require('../../src/services/ConfigService')

        it('returns all defaults when all args are null', function () {
            const result = resolveArgs([null, null, null, null])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
            expect(result.branch).to.be.null
        })

        it('returns all defaults when all args are undefined', function () {
            const result = resolveArgs([undefined, undefined])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('returns all defaults when all args are "all"', function () {
            const result = resolveArgs(['all', 'all', 'all'])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('classifies args correctly regardless of order', function () {
            const result = resolveArgs(['regtest', 'xchain-encoder', 'bitcoin'])
            expect(result.service).to.equal('xchain-encoder')
            expect(result.chain).to.equal('bitcoin')
            expect(result.network).to.equal('regtest')
        })

        it('treats unrecognized arg as branch when expectBranch is true', function () {
            const result = resolveArgs(['develop', 'xchain-encoder', 'bitcoin', 'mainnet'], { expectBranch: true })
            expect(result.branch).to.equal('develop')
            expect(result.service).to.equal('xchain-encoder')
        })

        it('uses defaultBranch when no branch found and expectBranch is true', function () {
            const result = resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet'], { expectBranch: true })
            expect(result.branch).to.equal('master')
        })

        it('uses custom defaultBranch when specified', function () {
            const result = resolveArgs(['xchain-encoder'], { expectBranch: true, defaultBranch: 'develop' })
            expect(result.branch).to.equal('develop')
        })

        it('does not set branch when expectBranch is false', function () {
            const result = resolveArgs(['unknownarg', 'bitcoin', 'mainnet'], { expectBranch: false })
            expect(result.branch).to.be.null
        })

        it('only takes the first unrecognized arg as branch', function () {
            const result = resolveArgs(['mybranch', 'otherbranch', 'bitcoin'], { expectBranch: true })
            expect(result.branch).to.equal('mybranch')
            // 'otherbranch' is silently ignored
        })

        it('handles empty args array', function () {
            const result = resolveArgs([])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('recognizes "node" as a service', function () {
            const result = resolveArgs(['node', 'bitcoin', 'mainnet'])
            expect(result.service).to.equal('node')
        })

        it('recognizes "database" as a service', function () {
            const result = resolveArgs(['database', 'bitcoin', 'mainnet'])
            expect(result.service).to.equal('database')
        })

        it('recognizes "explorer" as a service', function () {
            const result = resolveArgs(['explorer'])
            expect(result.service).to.equal('explorer')
        })
    })

    // ===================================================================
    // 3. filterCommandParameters boundaries
    // ===================================================================

    describe('ConfigService — filterCommandParameters boundaries', function () {
        const { filterCommandParameters } = require('../../src/services/ConfigService')

        it('returns empty module list for regtest-only service on mainnet', function () {
            const result = filterCommandParameters(null, 'xchain-regtest-miner', 'bitcoin', 'mainnet')
            expect(result['bitcoin']['mainnet']).to.deep.equal([])
        })

        it('returns empty module list for regtest-only service on testnet', function () {
            const result = filterCommandParameters(null, 'xchain-regtest-miner', 'bitcoin', 'testnet')
            expect(result['bitcoin']['testnet']).to.deep.equal([])
        })

        it('includes regtest-miner on regtest', function () {
            const result = filterCommandParameters(null, 'xchain-regtest-miner', 'bitcoin', 'regtest')
            expect(result['bitcoin']['regtest']).to.deep.equal(['xchain-regtest-miner'])
        })

        it('treats unknown service as literal module name', function () {
            const result = filterCommandParameters(null, 'unknown-service', 'bitcoin', 'mainnet')
            expect(result['bitcoin']['mainnet']).to.deep.equal(['unknown-service'])
        })

        it('full expansion (all/all/all) produces correct structure', function () {
            const result = filterCommandParameters(null, 'all', 'all', 'all')
            const coins = Object.values(Coin)
            const networks = Object.values(Network)

            for (const coin of coins) {
                expect(result).to.have.property(coin)
                for (const network of networks) {
                    expect(result[coin]).to.have.property(network)
                    const modules = result[coin][network]
                    expect(modules).to.include('xchain-encoder')
                    expect(modules).to.include('node')
                    if (network === 'regtest') {
                        expect(modules).to.include('xchain-regtest-miner')
                    } else {
                        expect(modules).to.not.include('xchain-regtest-miner')
                    }
                    expect(modules).to.not.include('xchain-e2e-test')
                }
            }

            // Explorer in shared slot
            expect(result['']).to.exist
            expect(result['']['']).to.include('xchain-explorer')
        })

        it('explorer special case sets coins to empty', function () {
            const result = filterCommandParameters(null, 'explorer', 'bitcoin', 'mainnet')
            // Should only have the shared '' key with explorer
            expect(result['']).to.exist
            expect(result['']['']).to.deep.equal(['xchain-explorer'])
            // Should NOT have bitcoin key since coins array was emptied
            expect(result['bitcoin']).to.be.undefined
        })
    })

    // ===================================================================
    // 4. Docker env var escaping (Fix 3)
    // ===================================================================

    describe('ModuleService — Docker env var passing (execFile)', function () {

        it('passes double quotes in environment variable values unescaped', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'TEST_VAR': 'hello"world'
                })
            })

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null, '')
                } else if (args[0] === 'run') {
                    expect(args).to.include('TEST_VAR=hello"world')
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })

            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
        })

        it('passes dollar signs in environment variable values unescaped', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'PRICE': 'costs_$100'
                })
            })

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null, '')
                } else if (args[0] === 'run') {
                    expect(args).to.include('PRICE=costs_$100')
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })

            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
        })

        it('passes backticks in environment variable values unescaped', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'CMD': 'run `whoami`'
                })
            })

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null, '')
                } else if (args[0] === 'run') {
                    expect(args).to.include('CMD=run `whoami`')
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })

            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
        })

        it('passes backslashes in environment variable values unescaped', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'PATH_VAR': 'C:\\Users\\test'
                })
            })

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null, '')
                } else if (args[0] === 'run') {
                    expect(args).to.include('PATH_VAR=C:\\Users\\test')
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })

            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
        })

        it('handles numeric values without error', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'PORT': 3002
                })
            })

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null, '')
                } else if (args[0] === 'run') {
                    expect(args).to.include('PORT=3002')
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })

            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
        })

        it('handles boolean false values', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'EXPLORER_API_USER': false
                })
            })

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null, '')
                } else if (args[0] === 'run') {
                    expect(args).to.include('EXPLORER_API_USER=false')
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })

            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
        })
    })

    // ===================================================================
    // 5. Branch name validation (Fix 4)
    // ===================================================================

    describe('ModuleService — branch name validation', function () {

        it('accepts valid branch names: master', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('-b')
                expect(args).to.include('master')
                cb(null, '', '')
            })

            await ms.cloneGit('xchain-encoder', true, false, 'master')
        })

        it('accepts valid branch names: feature/my-branch', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('-b')
                expect(args).to.include('feature/my-branch')
                cb(null, '', '')
            })

            await ms.cloneGit('xchain-encoder', true, false, 'feature/my-branch')
        })

        it('accepts valid branch names: v1.0.0', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('-b')
                expect(args).to.include('v1.0.0')
                cb(null, '', '')
            })

            await ms.cloneGit('xchain-encoder', true, false, 'v1.0.0')
        })

        it('accepts valid branch names: release_2.0', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('-b')
                expect(args).to.include('release_2.0')
                cb(null, '', '')
            })

            await ms.cloneGit('xchain-encoder', true, false, 'release_2.0')
        })

        it('rejects branch name with semicolon (shell injection)', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', true, false, '; rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with $() (command substitution)', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', true, false, '$(whoami)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with backticks', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', true, false, '`id`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with spaces', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', true, false, 'my branch')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with pipe', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', true, false, 'foo|bar')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('allows null branch (no -b flag)', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.not.include('-b')
                cb(null, '', '')
            })

            await ms.cloneGit('xchain-encoder', true, false, null)
        })

        it('rejects module with unknown git URL', async function () {
            const stubs = makeModuleServiceStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('nonexistent-module', true, false, 'master')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }
        })
    })

    // ===================================================================
    // 6. Grep/testName escaping (Fix 5)
    // ===================================================================

    describe('moduleOperations — grep/testName handling', function () {

        function loadModuleOperations(stubs) {
            return proxyquire('../../src/operations/moduleOperations', {
                '../config/constants': require('../../src/config/constants'),
                '../state': {
                    db: stubs.db
                },
                '../services/ConfigService': {
                    getDockerContainerImageName: (m, c, n) => `xchain-node-${c}-${n}-${m}`,
                    filterCommandParameters: require('../../src/services/ConfigService').filterCommandParameters,
                    getDockerNetwork: (c, n) => `xchain-node-${c}-${n}`
                },
                '../services/DockerService': {
                    createDockerNetwork: sinon.stub().resolves(true),
                    killContainer: sinon.stub().resolves(true),
                    removeContainer: stubs.removeContainer || sinon.stub().resolves(true),
                    stopContainer: sinon.stub().resolves(true),
                    startContainer: sinon.stub().resolves(true),
                    restartContainer: sinon.stub().resolves(true),
                    execContainer: sinon.stub().resolves(''),
                    shellContainer: sinon.stub().resolves(true),
                    logContainer: sinon.stub().resolves(true),
                    startDockerMonitor: sinon.stub().resolves(true),
                    waitContainer: stubs.waitContainer || sinon.stub().resolves(0),
                    saveContainerLogs: stubs.saveContainerLogs || sinon.stub().resolves(true)
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: sinon.stub().resolves(true),
                    resetDatabases: sinon.stub().resolves(true)
                },
                '../services/ModuleService': {
                    cloneGit: sinon.stub().resolves(true),
                    getModuleBranch: sinon.stub().resolves('master'),
                    installModule: stubs.installModule || sinon.stub().resolves('a'.repeat(64)),
                    uninstallModule: sinon.stub().resolves(true)
                },
                '../services/StatusService': {
                    statusChanged: sinon.stub().resolves()
                }
            })
        }

        it('passes grep pattern as separate array element', async function () {
            let capturedDockerCmdArgs = null
            const stubs = {
                db: { getModuleContainer: sinon.stub().resolves('abc123') },
                waitContainer: sinon.stub().resolves(0),
                saveContainerLogs: sinon.stub().resolves(true),
                removeContainer: sinon.stub().resolves(true),
                installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                    capturedDockerCmdArgs = dockerCmdArgs
                    return Promise.resolve('a'.repeat(64))
                })
            }

            const ops = loadModuleOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', 'order', 'test "injection"')

            expect(capturedDockerCmdArgs).to.include('--grep')
            expect(capturedDockerCmdArgs).to.include('test "injection"')
        })

        it('passes backslashes in grep pattern unescaped', async function () {
            let capturedDockerCmdArgs = null
            const stubs = {
                db: { getModuleContainer: sinon.stub().resolves('abc123') },
                waitContainer: sinon.stub().resolves(0),
                saveContainerLogs: sinon.stub().resolves(true),
                removeContainer: sinon.stub().resolves(true),
                installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                    capturedDockerCmdArgs = dockerCmdArgs
                    return Promise.resolve('a'.repeat(64))
                })
            }

            const ops = loadModuleOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', 'order', 'path\\test')

            expect(capturedDockerCmdArgs).to.include('--grep')
            expect(capturedDockerCmdArgs).to.include('path\\test')
        })

        it('includes testName in file path array element', async function () {
            let capturedDockerCmdArgs = null
            const stubs = {
                db: { getModuleContainer: sinon.stub().resolves('abc123') },
                waitContainer: sinon.stub().resolves(0),
                saveContainerLogs: sinon.stub().resolves(true),
                removeContainer: sinon.stub().resolves(true),
                installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                    capturedDockerCmdArgs = dockerCmdArgs
                    return Promise.resolve('a'.repeat(64))
                })
            }

            const ops = loadModuleOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', 'test"name', null)

            expect(capturedDockerCmdArgs.some(a => a.includes('test"name.test.js'))).to.be.true
        })

        it('handles null grep and null testName', async function () {
            let capturedDockerCmdArgs = null
            const stubs = {
                db: { getModuleContainer: sinon.stub().resolves('abc123') },
                waitContainer: sinon.stub().resolves(0),
                saveContainerLogs: sinon.stub().resolves(true),
                removeContainer: sinon.stub().resolves(true),
                installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                    capturedDockerCmdArgs = dockerCmdArgs
                    return Promise.resolve('a'.repeat(64))
                })
            }

            const ops = loadModuleOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', null, null)

            expect(capturedDockerCmdArgs).to.be.null
        })

        it('does not add --grep when testName is null even if grep is set', async function () {
            let capturedDockerCmdArgs = null
            const stubs = {
                db: { getModuleContainer: sinon.stub().resolves('abc123') },
                waitContainer: sinon.stub().resolves(0),
                saveContainerLogs: sinon.stub().resolves(true),
                removeContainer: sinon.stub().resolves(true),
                installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                    capturedDockerCmdArgs = dockerCmdArgs
                    return Promise.resolve('a'.repeat(64))
                })
            }

            const ops = loadModuleOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', null, 'some pattern')

            // dockerCmdArgs is null when testName is null, so grep is not appended
            expect(capturedDockerCmdArgs).to.be.null
        })
    })

    // ===================================================================
    // 7. LevelDB boundaries
    // ===================================================================

    describe('LevelUpDb — boundary conditions', function () {

        describe('non-TTY lock handling (Fix 6)', function () {

            it('throws immediately in non-TTY when database is locked', async function () {
                const LevelUpStore = proxyquire('../../src/LevelUpDb', {
                    'levelup': sinon.stub().callsFake((backend, cb) => {
                        const err = new Error('IO error: lock file')
                        err.message = 'IO error: could not lock file'
                        cb(err)
                    }),
                    'leveldown': sinon.stub(),
                    'fs': {
                        existsSync: sinon.stub().returns(true),
                        unlinkSync: sinon.stub()
                    }
                })

                const origTTY = process.stdin.isTTY
                try {
                    process.stdin.isTTY = false
                    const store = new LevelUpStore('test', '/tmp')
                    await store.createDatabase()
                    expect.fail('should have thrown')
                } catch (err) {
                    expect(err.message).to.include('non-interactive')
                    expect(err.message).to.include('lock')
                } finally {
                    process.stdin.isTTY = origTTY
                }
            })
        })

        describe('key format and data integrity', function () {
            let testDb

            beforeEach(async function () {
                testDb = levelup(memdown())
            })

            afterEach(async function () {
                if (testDb && testDb.isOpen()) await testDb.close()
            })

            it('stores and retrieves module container with empty coin/network (shared services)', async function () {
                const LevelUpStore = require('../../src/LevelUpDb')
                const store = new LevelUpStore('test', '/tmp')
                store.db = testDb

                await store.insertModuleContainer('xchain-hub', '', '', 'a'.repeat(64))
                const result = await store.getModuleContainer('xchain-hub', '', '')
                expect(result).to.equal('a'.repeat(64))
            })

            it('returns null for non-existent key', async function () {
                const LevelUpStore = require('../../src/LevelUpDb')
                const store = new LevelUpStore('test', '/tmp')
                store.db = testDb

                const result = await store.getModuleContainer('nonexistent', 'bitcoin', 'mainnet')
                expect(result).to.be.null
            })

            it('overwrites existing container ID on re-insert', async function () {
                const LevelUpStore = require('../../src/LevelUpDb')
                const store = new LevelUpStore('test', '/tmp')
                store.db = testDb

                await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'a'.repeat(64))
                await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'b'.repeat(64))
                const result = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
                expect(result).to.equal('b'.repeat(64))
            })

            it('removes module container and returns old ID', async function () {
                const LevelUpStore = require('../../src/LevelUpDb')
                const store = new LevelUpStore('test', '/tmp')
                store.db = testDb

                const id = 'c'.repeat(64)
                await store.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', id)
                const removed = await store.removeModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')
                expect(removed).to.equal(id)

                const after = await store.getModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')
                expect(after).to.be.null
            })

            it('getAllModuleContainers returns only entries with 3-part keys', async function () {
                const LevelUpStore = require('../../src/LevelUpDb')
                const store = new LevelUpStore('test', '/tmp')
                store.db = testDb

                // Valid 3-part key
                await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'a'.repeat(64))

                // Manually insert a malformed key with 4 parts (simulates ; in module name)
                await testDb.put('MCbad;key;extra;part', 'x'.repeat(64))

                const modules = await store.getAllModuleContainers(null, null)
                expect(modules).to.have.lengthOf(1)
                expect(modules[0].module).to.equal('xchain-encoder')
            })

            it('getAllModuleContainers filters by coin/network', async function () {
                const LevelUpStore = require('../../src/LevelUpDb')
                const store = new LevelUpStore('test', '/tmp')
                store.db = testDb

                await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'a'.repeat(64))
                await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'b'.repeat(64))
                await store.insertModuleContainer('xchain-hub', '', '', 'c'.repeat(64))

                const btcModules = await store.getAllModuleContainers('bitcoin', 'mainnet')
                // Should include bitcoin-mainnet entry AND shared entries (empty coin/network)
                expect(btcModules).to.have.lengthOf(2)
                const moduleNames = btcModules.map(m => m.module)
                expect(moduleNames).to.include('xchain-encoder')
                expect(moduleNames).to.include('xchain-hub')
            })
        })
    })

    // ===================================================================
    // 8. Docker naming boundaries
    // ===================================================================

    describe('ConfigService — naming helper boundaries', function () {
        const {
            getDockerContainerImageName,
            getDockerNetwork,
            getModuleDatabaseName
        } = require('../../src/services/ConfigService')

        it('getDockerNetwork with both empty strings returns just prefix', function () {
            expect(getDockerNetwork('', '')).to.equal('xchain-node')
        })

        it('getDockerNetwork with coin only returns prefix-coin', function () {
            expect(getDockerNetwork('bitcoin', '')).to.equal('xchain-node-bitcoin')
        })

        it('getDockerContainerImageName uses prefix for all shared modules', function () {
            const shared = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME]
            for (const mod of shared) {
                const name = getDockerContainerImageName(mod, 'bitcoin', 'mainnet')
                expect(name).to.equal('xchain-node-' + mod)
            }
        })

        it('getModuleDatabaseName capitalizes network correctly', function () {
            expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.include('Mainnet')
            expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'testnet')).to.include('Testnet')
            expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'regtest')).to.include('Regtest')
        })

        it('getModuleDatabaseName uses correct ticker for all coins', function () {
            for (const coin of Object.values(Coin)) {
                const name = getModuleDatabaseName('xchain-decoder', coin, 'mainnet')
                expect(name).to.include(CoinTickerSymbol[coin])
            }
        })
    })
})
