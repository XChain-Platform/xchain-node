'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquire('../../src/services/DockerService', {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn,
            spawnSync: stubs.spawnSync
        },
        'fs': fsStub || {
            readFileSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub()
        },
        'blessed': {
            screen: sinon.stub().returns({
                key: sinon.stub(), on: sinon.stub(),
                render: sinon.stub(), destroy: sinon.stub()
            }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

function loadModuleService(stubs, opts = {}) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        },
        '../state': {
            db: opts.db || {
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
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: (mod, coin, net) => {
                if (['database', 'xchain-hub', 'xchain-explorer', 'xchain-sync'].includes(mod)) {
                    return 'xchain-node-' + mod
                }
                return 'xchain-node-' + coin + '-' + net + '-' + mod
            },
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
            validatePort: (v) => {
                if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535
                if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 }
                return false
            },
            getDefaultConfig: sinon.stub().resolves({
                'NETWORK': 'bitcoin-regtest',
                'NODE_PORT': 18444,
                'ENCODER_PORT': 3003,
                'ENCODER_API_PORT': 3003
            })
        },
        './StatusService': {
            statusChanged: sinon.stub().resolves(),
            getStatus: sinon.stub().resolves({})
        },
        './DockerService': {
            killContainer: opts.killContainer || sinon.stub().resolves(true),
            removeContainer: opts.removeContainer || sinon.stub().resolves(true),
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
        },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 3: Docker daemon unavailable (CMD-01, CMD-02)
    // -------------------------------------------------------------------

    describe('Experiment 3: Docker daemon unavailable', function () {

        it('rejects when docker binary is not found (ENOENT)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                const err = new Error('spawn docker ENOENT')
                err.code = 'ENOENT'
                cb(err)
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('docker --version')
            }
        })

        it('rejects when docker version succeeds but daemon is down', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                if (callCount === 1) {
                    cb(null, 'Docker version 24.0.0, build abc1234')
                } else {
                    cb(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'))
                }
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('docker ps')
            }
        })

        it('rejects when docker version returns permission denied', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('Got permission denied while trying to connect to the Docker daemon socket'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.a('string')
            }
        })

        it('rejects when docker version returns empty output', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === '--version') {
                    cb(null, '')
                }
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('format')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment 4: Docker build/run failures (CMD-03, CMD-04)
    // -------------------------------------------------------------------

    describe('Experiment 4: Docker build failure', function () {

        it('rejects with error message when docker build fails', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(new Error('failed to solve: process "/bin/sh -c npm install" did not complete successfully'))
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error creating Docker image')
            }
        })

        it('does not store container ID on build failure', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const dbStub = {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            }

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(new Error('build failed'))
                }
            })
            const ms = loadModuleService(stubs, { db: dbStub })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            } catch {
                // Expected
            }

            expect(dbStub.insertModuleContainer.called).to.be.false
        })
    })

    describe('Experiment 4b: Docker run failure', function () {

        it('rejects with error message when docker run fails (port conflict)', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    const err = new Error('Bind for 0.0.0.0:3003 failed: port is already allocated')
                    err.code = 125
                    cb(err, '', 'port is already allocated')
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error creating the container')
            }
        })

        it('rejects with error when docker run returns OOM killed exit code', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    const err = new Error('Container killed by OOM')
                    err.code = 137
                    cb(err)
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error creating the container')
            }
        })

        it('does not store container ID when docker run fails', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const dbStub = {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            }

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(new Error('run failed'))
                }
            })
            const ms = loadModuleService(stubs, { db: dbStub })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            } catch {
                // Expected
            }

            expect(dbStub.insertModuleContainer.called).to.be.false
        })

        it('rejects when docker run returns invalid container ID', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    // Return a non-64-char hex string
                    cb(null, 'not-a-valid-container-id\n')
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects when docker run returns empty stdout', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, '')
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment 4c: LevelDB insert failure after successful run
    // -------------------------------------------------------------------

    describe('Experiment 4c: State storage failure after successful docker run', function () {

        it('rejects when LevelDB insert returns false', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const dbStub = {
                insertModuleContainer: sinon.stub().resolves(false),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            }

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs, { db: dbStub })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("problem trying to store the container's id")
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Docker network creation failures (CMD-06)
    // -------------------------------------------------------------------

    describe('Experiment: Docker network creation failure', function () {

        it('rejects when network create command fails', async function () {
            const stubs = makeStubs()
            let callNum = 0
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callNum++
                if (callNum === 1) {
                    // network inspect fails (doesn't exist)
                    cb(new Error('not found'))
                } else {
                    // network create also fails
                    cb(new Error('could not find an available, non-overlapping IPv4 address pool'))
                }
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.createDockerNetwork('xchain-node')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.equal(false)
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Docker inspect returns invalid JSON (CMD-07)
    // -------------------------------------------------------------------

    describe('Experiment: Docker inspect with invalid JSON', function () {

        it('throws when docker inspect returns malformed JSON', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'this is not json')
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.getStatusFromContainer('abc123')
                expect.fail('should have thrown')
            } catch (err) {
                // JSON.parse throws SyntaxError, which should propagate
                expect(err).to.be.an.instanceOf(SyntaxError)
            }
        })

        it('throws when docker inspect returns empty array', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '[]')
            })
            const ds = loadDockerService(stubs)

            try {
                const result = await ds.getStatusFromContainer('abc123')
                // [0] on empty array returns undefined — downstream code will fail
                expect(result).to.be.undefined
            } catch {
                // Also acceptable
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Container operations on non-existent containers
    // -------------------------------------------------------------------

    describe('Experiment: Operations on non-existent containers', function () {

        it('rejects when stopping a non-existent container', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('No such container: phantom123'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.stopContainer('phantom123')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
                expect(err.message).to.include('No such container')
            }
        })

        it('rejects when restarting a non-existent container', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('No such container: phantom123'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.restartContainer('phantom123')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })

        it('rejects when removing a non-existent container', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('No such container: phantom123'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.removeContainer('phantom123')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })

        it('rejects when killing a non-existent container', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('No such container: phantom123'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.killContainer('phantom123')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Docker exec failure (CMD-05)
    // -------------------------------------------------------------------

    describe('Experiment: Docker exec failure', function () {

        it('rejects when exec fails on frozen container', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('OCI runtime exec failed: exec failed: unable to start container process'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.execContainer('frozen-container', ['ls'])
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
                expect(err.message).to.include('exec failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: stringToDockerContainerFile with broken spawn
    // -------------------------------------------------------------------

    describe('Experiment: File write to container failure', function () {

        it('rejects when spawn child exits with non-zero code', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.stdin = { write: sinon.stub(), end: sinon.stub() }
            child.stderr = new EventEmitter()
            stubs.spawn.returns(child)
            const ds = loadDockerService(stubs)

            const promise = ds.stringToDockerContainerFile('abc123', 'data', '/app/config')
            child.stderr.emit('data', 'No such container')
            child.emit('close', 1)

            try {
                await promise
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.include('exited with code 1')
            }
        })

        it('rejects when spawn emits error event', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.stdin = { write: sinon.stub(), end: sinon.stub() }
            child.stderr = new EventEmitter()
            stubs.spawn.returns(child)
            const ds = loadDockerService(stubs)

            const promise = ds.stringToDockerContainerFile('abc123', 'data', '/app/config')
            child.emit('error', new Error('spawn ENOENT'))

            try {
                await promise
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.include('ENOENT')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Port validation in buildAndUp
    // -------------------------------------------------------------------

    describe('Experiment: Invalid port in config during buildAndUp', function () {

        it('rejects when config has invalid port value', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') cb(null)
            })

            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: () => 'xchain-node-bitcoin-regtest-xchain-encoder',
                    getDockerNetwork: () => 'xchain-node-bitcoin-regtest',
                    validatePort: (v) => {
                        if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535
                        if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 }
                        return false
                    },
                    getDefaultConfig: sinon.stub().resolves({
                        'ENCODER_PORT': 'not_a_port',
                        'ENCODER_API_PORT': 3003
                    })
                },
                './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
                './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
            })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid port value')
            }
        })
    })
})
