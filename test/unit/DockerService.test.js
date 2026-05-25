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
        'util': { promisify: (fn) => fn },
        'fs': fsStub || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({
                key: sinon.stub(),
                on: sinon.stub(),
                render: sinon.stub(),
                destroy: sinon.stub()
            }),
            text: sinon.stub(),
            log: sinon.stub().returns({
                log: sinon.stub()
            })
        }
    })
}

describe('DockerService', function () {

    // -------------------------------------------------------------------
    // checkDockerInstalledAndReachable
    // -------------------------------------------------------------------

    describe('checkDockerInstalledAndReachable()', function () {

        it('resolves true when docker --version and docker ps succeed', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === '--version') {
                    cb(null, 'Docker version 24.0.0, build abc1234')
                } else if (args[0] === 'ps') {
                    cb(null, '')
                }
            })
            const ds = loadDockerService(stubs)
            const result = await ds.checkDockerInstalledAndReachable()
            expect(result).to.be.true
        })

        it('rejects when docker --version fails', async function () {
            const stubs = makeStubs()
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

        it('rejects when docker --version returns unexpected format', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === '--version') {
                    cb(null, 'unexpected output')
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

        it('rejects when docker ps fails (user not in docker group)', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                if (callCount === 1) {
                    cb(null, 'Docker version 24.0.0, build abc1234')
                } else {
                    cb(new Error('permission denied'))
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
    })

    // -------------------------------------------------------------------
    // Container lifecycle commands
    // -------------------------------------------------------------------

    describe('startContainer()', function () {
        it('runs docker start <containerId>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['start', 'abc123'])
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.startContainer('abc123')
            expect(result).to.be.true
        })

        it('rejects when stdout does not match container ID', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'unexpected')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.startContainer('abc123')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('error')
            }
        })

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.startContainer('abc123')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    describe('stopContainer()', function () {
        it('runs docker stop <containerId>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['stop', 'abc123'])
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.stopContainer('abc123')
            expect(result).to.be.true
        })

        it('rejects when stdout does not match', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'wrong')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.stopContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.include('abc123')
            }
        })
    })

    describe('restartContainer()', function () {
        it('runs docker restart <containerId>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['restart', 'abc123'])
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.restartContainer('abc123')
            expect(result).to.be.true
        })
    })

    describe('killContainer()', function () {
        it('runs docker kill <containerId>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['kill', 'abc123'])
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.killContainer('abc123')
            expect(result).to.be.true
        })
    })

    describe('removeContainer()', function () {
        it('runs docker rm <containerId>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['rm', 'abc123'])
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.removeContainer('abc123')
            expect(result).to.be.true
        })

        it('treats "No such container" as success (idempotent)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                const err = new Error('Command failed')
                err.code = 1
                cb(err, '', 'Error response from daemon: No such container: abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.removeContainer('abc123')
            expect(result).to.be.true
        })

        it('rejects on other errors', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                const err = new Error('Cannot connect to the Docker daemon')
                err.code = 1
                cb(err, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
            })
            const ds = loadDockerService(stubs)
            let rejected = false
            try { await ds.removeContainer('abc123') } catch { rejected = true }
            expect(rejected).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // getStatusFromContainer
    // -------------------------------------------------------------------

    describe('getStatusFromContainer()', function () {
        it('runs docker inspect and returns parsed JSON', async function () {
            const stubs = makeStubs()
            const inspectData = [{ State: { Status: 'running' }, NetworkSettings: {} }]
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['inspect', 'abc123'])
                cb(null, JSON.stringify(inspectData))
            })
            const ds = loadDockerService(stubs)
            const result = await ds.getStatusFromContainer('abc123')
            expect(result.State.Status).to.equal('running')
        })

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.getStatusFromContainer('bad-id')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // Network operations
    // -------------------------------------------------------------------

    describe('createDockerNetwork()', function () {
        it('creates network when inspect fails (network does not exist)', async function () {
            const stubs = makeStubs()
            let callNum = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callNum++
                if (callNum === 1) {
                    expect(cmd).to.equal('docker')
                    expect(args).to.deep.equal(['network', 'inspect', 'mynet'])
                    cb(new Error('not found'))
                } else {
                    expect(cmd).to.equal('docker')
                    expect(args).to.deep.equal(['network', 'create', 'mynet'])
                    cb(null)
                }
            })
            const ds = loadDockerService(stubs)
            const result = await ds.createDockerNetwork('mynet')
            expect(result).to.be.true
        })

        it('resolves true when network already exists', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '[]')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.createDockerNetwork('mynet')
            expect(result).to.be.true
        })
    })

    describe('getDockerNetworkInspect()', function () {
        it('runs docker network inspect and parses JSON', async function () {
            const stubs = makeStubs()
            const data = [{ Name: 'mynet', IPAM: {} }]
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['network', 'inspect', 'mynet'])
                cb(null, JSON.stringify(data))
            })
            const ds = loadDockerService(stubs)
            const result = await ds.getDockerNetworkInspect('mynet')
            expect(result.Name).to.equal('mynet')
        })
    })

    // -------------------------------------------------------------------
    // Container interaction
    // -------------------------------------------------------------------

    describe('execContainer()', function () {
        it('runs docker exec -i <containerId> <commandArgs>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['exec', '-i', 'abc123', 'ls', '-la'])
                cb(null, 'file1\nfile2\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.execContainer('abc123', ['ls', '-la'])
            expect(result).to.equal('file1\nfile2')
        })
    })

    describe('shellContainer()', function () {
        it('calls spawnSync with docker exec -it <containerId> bash', async function () {
            const stubs = makeStubs()
            stubs.spawnSync.returns({ status: 0 })
            const ds = loadDockerService(stubs)
            await ds.shellContainer('abc123')
            expect(stubs.spawnSync.calledOnce).to.be.true
            const [cmd, args, opts] = stubs.spawnSync.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.deep.equal(['exec', '-it', 'abc123', 'bash'])
            expect(opts.stdio).to.equal('inherit')
        })
    })

    describe('logContainer()', function () {
        it('calls spawn with --tail and --follow for follow=true', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.kill = sinon.stub()
            stubs.spawn.returns(child)
            const promise = loadDockerService(stubs).logContainer('abc123', true)
            const [cmd, args] = stubs.spawn.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.include('--tail')
            expect(args).to.include('10')
            expect(args).to.include('--follow')
            expect(args).to.include('abc123')
            child.emit('close')
            await promise
        })

        it('calls spawn without --follow for follow=false', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.kill = sinon.stub()
            stubs.spawn.returns(child)
            const promise = loadDockerService(stubs).logContainer('abc123', false)
            const [cmd, args] = stubs.spawn.firstCall.args
            expect(args).to.not.include('--follow')
            child.emit('close')
            await promise
        })
    })

    // -------------------------------------------------------------------
    // File transfer
    // -------------------------------------------------------------------

    describe('getDockerContainerFileData()', function () {
        it('runs docker cp and reads the copied file', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args[0]).to.equal('cp')
                expect(args[1]).to.include('abc123:/app/data.json')
                cb(null)
            })
            const fsStub = {
                readFileSync: sinon.stub().returns('{"key":"value"}')
            }
            const ds = loadDockerService(stubs, fsStub)
            const result = await ds.getDockerContainerFileData('abc123', '/app/data.json')
            expect(result).to.equal('{"key":"value"}')
        })
    })

    describe('getDockerContainerFileCat()', function () {
        it('runs docker exec cat <path>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['exec', '-i', 'abc123', 'cat', '/app/config.json'])
                cb(null, '{"config":true}')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.getDockerContainerFileCat('abc123', '/app/config.json')
            expect(result).to.equal('{"config":true}')
        })
    })

    // -------------------------------------------------------------------
    // startDockerMonitor
    // -------------------------------------------------------------------

    describe('startDockerMonitor()', function () {
        it('rejects when containerIds is empty', async function () {
            const stubs = makeStubs()
            const ds = loadDockerService(stubs)
            try {
                await ds.startDockerMonitor([], true)
                expect.fail()
            } catch (err) {
                expect(err).to.include('No container')
            }
        })

        it('rejects when containerIds is null', async function () {
            const stubs = makeStubs()
            const ds = loadDockerService(stubs)
            try {
                await ds.startDockerMonitor(null, true)
                expect.fail()
            } catch (err) {
                expect(err).to.include('No container')
            }
        })
    })
})
