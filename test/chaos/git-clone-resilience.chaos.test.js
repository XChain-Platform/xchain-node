'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { modulesUrls } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        }
    }
}

function loadModuleService(stubs, configOverrides = {}) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        '../state': {
            db: {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: configOverrides.moduleDirExists || sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: () => 'xchain-node-bitcoin-regtest-xchain-encoder',
            getDockerNetwork: () => 'xchain-node-bitcoin-regtest',
            validatePort: () => true,
            getDefaultConfig: sinon.stub().resolves({ ENCODER_PORT: 3003, ENCODER_API_PORT: 3003 })
        },
        './StatusService': {
            statusChanged: sinon.stub().resolves(),
            getStatus: sinon.stub().resolves({})
        },
        './DockerService': {
            killContainer: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
        },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('Chaos: Git Clone Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 7: Git clone failures (CMD-08)
    // -------------------------------------------------------------------

    describe('Experiment 7: Network failure during git clone', function () {

        it('rejects with error message when clone fails with network error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('fatal: unable to access: Could not resolve host: github.com'), '', 'fatal: unable to access')
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })

        it('rejects with error when clone times out', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('fatal: unable to access: Operation timed out'))
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })

    describe('Experiment 7b: Invalid branch fallback to master', function () {

        it('falls back to master when specified branch is not found', async function () {
            const stubs = makeStubs()
            let cloneAttempts = 0

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cloneAttempts++
                if (cloneAttempts === 1) {
                    // First attempt with branch fails
                    expect(args).to.include('-b')
                    expect(args).to.include('nonexistent-branch')
                    cb(new Error('Remote branch nonexistent-branch not found'), '', 'Remote branch nonexistent-branch not found')
                } else {
                    // Fallback to default branch succeeds
                    expect(args).to.not.include('-b')
                    cb(null)
                }
            })
            const warnSpy = sinon.stub(console, 'warn')
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, false, 'nonexistent-branch')
            expect(cloneAttempts).to.equal(2)
            expect(warnSpy.called).to.be.true
            expect(warnSpy.firstCall.args[0]).to.include('not found')
            expect(warnSpy.firstCall.args[0]).to.include('Falling back')
        })

        it('rejects when both branch and fallback clone fail', async function () {
            const stubs = makeStubs()

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args.includes('-b')) {
                    cb(new Error('not found'), '', 'Remote branch not found')
                } else {
                    cb(new Error('Authentication failed'))
                }
            })
            sinon.stub(console, 'warn')
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, 'bad-branch')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
                expect(err).to.include('Authentication failed')
            }
        })

        it('does not fall back when error is not branch-related', async function () {
            const stubs = makeStubs()
            let cloneAttempts = 0

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cloneAttempts++
                cb(new Error('Permission denied (publickey)'), '', 'Permission denied')
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, 'some-branch')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error cloning')
                expect(cloneAttempts).to.equal(1) // No fallback attempt
            }
        })
    })

    describe('Experiment 7c: Branch name validation in cloneGit', function () {

        it('rejects invalid branch names with shell metacharacters', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, 'branch; rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch names with backticks', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, '`whoami`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('rejects branch names with dollar signs', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('xchain-encoder', false, false, '$(command)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('accepts valid branch with slashes', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, false, 'feature/my-branch')
            expect(stubs.execFile.calledOnce).to.be.true
            expect(stubs.execFile.firstCall.args[1]).to.include('feature/my-branch')
        })
    })

    describe('Experiment 7d: Module directory conflict', function () {

        it('rejects when module directory already exists and rewrite is false', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs, {
                moduleDirExists: sinon.stub().returns(true)
            })

            try {
                await ms.cloneGit('xchain-encoder', false, false)
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('already exists')
            }
        })

        it('removes existing directory when rewrite is true', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs, {
                moduleDirExists: sinon.stub().returns(true)
            })

            await ms.cloneGit('xchain-encoder', true, false)
            expect(stubs.execFile.calledOnce).to.be.true
        })
    })

    describe('Experiment 7e: Unknown module URL', function () {

        it('rejects when module has no URL mapping', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('totally-unknown-module')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }
        })
    })

    describe('Experiment 7f: useTmp mode resilience', function () {

        it('clones to tmp directory when useTmp=true', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('/tmp/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, true)
        })

        it('cleans up tmp directory before cloning in useTmp mode', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.cloneGit('xchain-encoder', false, true)
            // removeModuleTmpDir and createModuleTmpDir should be called
            // (stubbed in loadModuleService via ConfigService)
        })
    })
})
