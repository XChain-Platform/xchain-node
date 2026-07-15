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

        it('rejects when stdout does not match container ID and no stderr error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'different-id\n', '')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.removeContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.include('error')
            }
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

    // -------------------------------------------------------------------
    // addContainerToNetwork
    // -------------------------------------------------------------------

    describe('addContainerToNetwork()', function () {

        it('connects container when not already in network', async function () {
            const stubs = makeStubs()
            // First call: docker inspect → container status
            // Second call: docker network connect → success
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                if (args[0] === 'inspect') {
                    // Return container with no networks
                    cb(null, JSON.stringify([{
                        NetworkSettings: { Networks: {} }
                    }]))
                } else if (args[0] === 'network' && args[1] === 'connect') {
                    cb(null)
                } else {
                    cb(null, '')
                }
            })
            const ds = loadDockerService(stubs)
            const result = await ds.addContainerToNetwork('abc123', 'mynet')
            expect(result).to.be.true
            expect(stubs.execFile.getCalls().some(c => c.args[1] && c.args[1][1] === 'connect')).to.be.true
        })

        it('skips connect when container already in network', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'inspect') {
                    cb(null, JSON.stringify([{
                        NetworkSettings: { Networks: { mynet: { IPAddress: '172.0.0.2' } } }
                    }]))
                } else {
                    cb(null, '')
                }
            })
            const ds = loadDockerService(stubs)
            const result = await ds.addContainerToNetwork('abc123', 'mynet')
            expect(result).to.be.true
            // Should NOT have called network connect
            expect(stubs.execFile.getCalls().some(c => c.args[1] && c.args[1][1] === 'connect')).to.be.false
        })

        it('rejects when network connect fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'inspect') {
                    cb(null, JSON.stringify([{
                        NetworkSettings: { Networks: {} }
                    }]))
                } else if (args[0] === 'network' && args[1] === 'connect') {
                    cb(new Error('network connect failed'))
                } else {
                    cb(null, '')
                }
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.addContainerToNetwork('abc123', 'mynet')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // getPublishedHostPorts
    // -------------------------------------------------------------------

    describe('getPublishedHostPorts()', function () {

        function stubPs(stubs, output) {
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args[0]).to.equal('ps')
                expect(args).to.include('--format')
                cb(null, output)
            })
        }

        it('maps host ports to the containers publishing them (0.0.0.0 + :::)', async function () {
            const stubs = makeStubs()
            stubPs(stubs,
                'xchain-node-explorer\t0.0.0.0:80->8080/tcp, :::80->8080/tcp, 0.0.0.0:443->8443/tcp, :::443->8443/tcp\n' +
                'xchain-node-bitcoin-mainnet-xchain-indexer\t0.0.0.0:4010->4010/tcp\n'
            )
            const ds = loadDockerService(stubs)
            const map = await ds.getPublishedHostPorts()
            expect([...map.get('80')]).to.deep.equal(['xchain-node-explorer'])
            expect([...map.get('443')]).to.deep.equal(['xchain-node-explorer'])
            expect([...map.get('4010')]).to.deep.equal(['xchain-node-bitcoin-mainnet-xchain-indexer'])
        })

        it('records multiple containers contending for the same host port', async function () {
            const stubs = makeStubs()
            stubPs(stubs,
                'stackA-explorer\t0.0.0.0:80->8080/tcp\n' +
                'stackB-explorer\t0.0.0.0:80->8080/tcp\n'
            )
            const ds = loadDockerService(stubs)
            const map = await ds.getPublishedHostPorts()
            expect([...map.get('80')].sort()).to.deep.equal(['stackA-explorer', 'stackB-explorer'])
        })

        it('ignores exposed-but-unpublished ports (no "->")', async function () {
            const stubs = makeStubs()
            stubPs(stubs, 'some-db\t3306/tcp\n')
            const ds = loadDockerService(stubs)
            const map = await ds.getPublishedHostPorts()
            expect(map.size).to.equal(0)
        })

        it('parses host-IP-scoped bindings (127.0.0.1:13306->3306)', async function () {
            const stubs = makeStubs()
            stubPs(stubs, 'xchain-node-database\t127.0.0.1:13306->3306/tcp\n')
            const ds = loadDockerService(stubs)
            const map = await ds.getPublishedHostPorts()
            expect([...map.get('13306')]).to.deep.equal(['xchain-node-database'])
        })

        it('returns an empty map when docker ps fails (best-effort)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('docker daemon unreachable'))
            })
            const ds = loadDockerService(stubs)
            const map = await ds.getPublishedHostPorts()
            expect(map.size).to.equal(0)
        })

        it('returns an empty map when there are no running containers', async function () {
            const stubs = makeStubs()
            stubPs(stubs, '')
            const ds = loadDockerService(stubs)
            const map = await ds.getPublishedHostPorts()
            expect(map.size).to.equal(0)
        })
    })

    // -------------------------------------------------------------------
    // waitContainer
    // -------------------------------------------------------------------

    describe('waitContainer()', function () {

        it('runs docker wait and returns parsed exit code', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['wait', 'abc123'])
                cb(null, '0\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.waitContainer('abc123')
            expect(result).to.equal(0)
        })

        it('returns non-zero exit code', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '1\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.waitContainer('abc123')
            expect(result).to.equal(1)
        })

        it('rejects on error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('wait failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.waitContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // stringToDockerContainerFile
    // -------------------------------------------------------------------

    describe('stringToDockerContainerFile()', function () {

        it('resolves true when tee exits with code 0', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Writable, Readable } = require('stream')

            const stdin = new Writable({
                write(chunk, enc, cb) { cb() }
            })
            stdin.end = sinon.stub()

            const stderr = new Readable({ read() {} })
            const child = new EventEmitter()
            child.stdin = stdin
            child.stderr = stderr
            stubs.spawn.returns(child)

            const ds = loadDockerService(stubs)
            const promise = ds.stringToDockerContainerFile('abc123', 'data content', '/app/config.json')

            const [cmd, args] = stubs.spawn.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.include('abc123')
            expect(args).to.include('tee')
            expect(args).to.include('/app/config.json')

            child.emit('close', 0)
            const result = await promise
            expect(result).to.be.true
        })

        it('rejects when tee exits with non-zero code', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Writable, Readable } = require('stream')

            const stdin = new Writable({ write(chunk, enc, cb) { cb() } })
            stdin.end = sinon.stub()
            const stderr = new Readable({ read() {} })
            const child = new EventEmitter()
            child.stdin = stdin
            child.stderr = stderr
            stubs.spawn.returns(child)

            const ds = loadDockerService(stubs)
            const promise = ds.stringToDockerContainerFile('abc123', 'data', '/app/file.txt')
            child.emit('close', 1)
            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('code 1')
            }
        })

        it('rejects on spawn error', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Writable, Readable } = require('stream')

            const stdin = new Writable({ write(chunk, enc, cb) { cb() } })
            stdin.end = sinon.stub()
            const stderr = new Readable({ read() {} })
            const child = new EventEmitter()
            child.stdin = stdin
            child.stderr = stderr
            stubs.spawn.returns(child)

            const ds = loadDockerService(stubs)
            const promise = ds.stringToDockerContainerFile('abc123', 'data', '/app/file.txt')
            child.emit('error', new Error('spawn error'))
            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('spawn error')
            }
        })
    })

    // -------------------------------------------------------------------
    // saveContainerLogs
    // -------------------------------------------------------------------

    describe('saveContainerLogs()', function () {

        it('spawns docker logs and pipes to file, resolves when output finishes', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Readable, Writable } = require('stream')

            // Mock fs for saveContainerLogs
            const mockWriteStream = new EventEmitter()
            mockWriteStream.write = sinon.stub()
            mockWriteStream.end = sinon.stub().callsFake(() => {
                // Simulate finish event after end() is called
                setImmediate(() => mockWriteStream.emit('finish'))
            })

            const fsStub = {
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(mockWriteStream),
                readFileSync: sinon.stub()
            }

            // Create a child process that emits close
            const stdoutStream = new Readable({ read() {} })
            const stderrStream = new Readable({ read() {} })
            const child = new EventEmitter()
            child.stdout = stdoutStream
            child.stderr = stderrStream

            // pipe on Readable needs to work
            stdoutStream.pipe = sinon.stub().returns(mockWriteStream)
            stderrStream.pipe = sinon.stub().returns(mockWriteStream)

            stubs.spawn.returns(child)

            const ds = loadDockerService(stubs, fsStub)
            const promise = ds.saveContainerLogs('abc123', '/logs/test.log')

            // Emit close to trigger output.end()
            child.emit('close')

            const result = await promise
            expect(result).to.be.true
            expect(fsStub.mkdirSync.calledOnce).to.be.true
            expect(stubs.spawn.calledWith('docker', ['logs', 'abc123'])).to.be.true
        })

        it('rejects when spawn emits error', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Readable } = require('stream')

            const mockWriteStream = new EventEmitter()
            mockWriteStream.write = sinon.stub()
            mockWriteStream.end = sinon.stub()
            const fsStub = {
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(mockWriteStream),
                readFileSync: sinon.stub()
            }

            const stdoutStream = new Readable({ read() {} })
            const stderrStream = new Readable({ read() {} })
            stdoutStream.pipe = sinon.stub().returns(mockWriteStream)
            stderrStream.pipe = sinon.stub().returns(mockWriteStream)

            const child = new EventEmitter()
            child.stdout = stdoutStream
            child.stderr = stderrStream
            stubs.spawn.returns(child)

            const ds = loadDockerService(stubs, fsStub)
            const promise = ds.saveContainerLogs('abc123', '/logs/test.log')
            child.emit('error', new Error('spawn error'))
            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('spawn error')
            }
        })
    })

    // -------------------------------------------------------------------
    // restartContainer: error branch
    // -------------------------------------------------------------------

    describe('restartContainer(): error branches', function () {

        it('rejects when stdout does not match container ID', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'wrong-id\n')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.restartContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.include('error')
            }
        })

        it('rejects when execFile errors', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('restart failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.restartContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // killContainer: error branches
    // -------------------------------------------------------------------

    describe('killContainer(): error branches', function () {

        it('rejects when stdout does not match container ID', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'wrong-id\n')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.killContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.include('error')
            }
        })

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('kill failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.killContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // execContainer: error branch
    // -------------------------------------------------------------------

    describe('execContainer(): error branch', function () {

        it('rejects when docker exec fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('exec failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.execContainer('abc123', ['ls'])
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // getDockerContainerFileData: error branch
    // -------------------------------------------------------------------

    describe('getDockerContainerFileData(): error branch', function () {

        it('rejects when docker cp fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('cp failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.getDockerContainerFileData('abc123', '/app/file.txt')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // getDockerContainerFileCat: error branch
    // -------------------------------------------------------------------

    describe('getDockerContainerFileCat(): error branch', function () {

        it('rejects when docker exec cat fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('cat failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.getDockerContainerFileCat('abc123', '/app/file.txt')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // createDockerNetwork: network create failure
    // -------------------------------------------------------------------

    describe('createDockerNetwork(): network create failure', function () {

        it('rejects false when network create fails', async function () {
            const stubs = makeStubs()
            let callNum = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callNum++
                if (callNum === 1) { cb(new Error('not found')) } // inspect fails
                else { cb(new Error('create failed')) }            // create fails
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.createDockerNetwork('mynet')
                expect.fail()
            } catch (err) {
                expect(err).to.equal(false)
            }
        })
    })

    // -------------------------------------------------------------------
    // getDockerNetworkInspect: error branch
    // -------------------------------------------------------------------

    describe('getDockerNetworkInspect(): error branch', function () {

        it('rejects when docker network inspect fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('inspect failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.getDockerNetworkInspect('mynet')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // stopContainer: error branches
    // -------------------------------------------------------------------

    describe('stopContainer(): error branches', function () {

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('stop failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.stopContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // logContainer: TTY + keypress branches
    // -------------------------------------------------------------------

    describe('logContainer(): TTY keypress branches', function () {

        it('sets up stdin raw mode and keypress handler when follow=true and isTTY=true', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.kill = sinon.stub()
            stubs.spawn.returns(child)

            // Temporarily patch process.stdin.isTTY to be truthy
            const originalIsTTY = process.stdin.isTTY
            const originalSetRawMode = process.stdin.setRawMode
            const originalSetEncoding = process.stdin.setEncoding
            process.stdin.isTTY = true
            process.stdin.setRawMode = sinon.stub()
            process.stdin.setEncoding = sinon.stub()

            const ds = loadDockerService(stubs)
            const promise = ds.logContainer('abc123', true)

            // Verify raw mode was set
            expect(process.stdin.setRawMode.calledWith(true)).to.be.true

            child.emit('close')
            await promise

            // Verify raw mode was unset on close
            expect(process.stdin.setRawMode.calledWith(false)).to.be.true

            process.stdin.isTTY = originalIsTTY
            process.stdin.setRawMode = originalSetRawMode
            process.stdin.setEncoding = originalSetEncoding
        })

        it('ESC keypress kills child process', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.kill = sinon.stub()
            stubs.spawn.returns(child)

            const originalIsTTY = process.stdin.isTTY
            const originalSetRawMode = process.stdin.setRawMode
            const originalSetEncoding = process.stdin.setEncoding
            process.stdin.isTTY = true
            process.stdin.setRawMode = sinon.stub()
            process.stdin.setEncoding = sinon.stub()

            const ds = loadDockerService(stubs)
            const promise = ds.logContainer('abc123', true)

            // Trigger ESC keypress (onKeypress callback)
            process.stdin.emit('data', '')
            expect(child.kill.calledWith('SIGTERM')).to.be.true

            child.emit('close')
            await promise

            process.stdin.isTTY = originalIsTTY
            process.stdin.setRawMode = originalSetRawMode
            process.stdin.setEncoding = originalSetEncoding
        })

        it('Ctrl-C keypress kills child process', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.kill = sinon.stub()
            stubs.spawn.returns(child)

            const originalIsTTY = process.stdin.isTTY
            const originalSetRawMode = process.stdin.setRawMode
            const originalSetEncoding = process.stdin.setEncoding
            process.stdin.isTTY = true
            process.stdin.setRawMode = sinon.stub()
            process.stdin.setEncoding = sinon.stub()

            const ds = loadDockerService(stubs)
            const promise = ds.logContainer('abc123', true)

            // Trigger Ctrl-C
            process.stdin.emit('data', '')
            expect(child.kill.calledWith('SIGTERM')).to.be.true

            child.emit('close')
            await promise

            process.stdin.isTTY = originalIsTTY
            process.stdin.setRawMode = originalSetRawMode
            process.stdin.setEncoding = originalSetEncoding
        })
    })

    // -------------------------------------------------------------------
    // startDockerMonitor: with containers (blessed UI)
    // -------------------------------------------------------------------

    describe('startDockerMonitor(): with containers', function () {

        it('sets up blessed UI, spawns docker logs for each container, resolves on q key', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Readable } = require('stream')

            // Set up mock children for docker logs spawn
            let keyHandler = null
            const mockScreen = {
                key: sinon.stub().callsFake((keys, handler) => { keyHandler = handler }),
                on: sinon.stub(),
                render: sinon.stub(),
                destroy: sinon.stub()
            }
            const mockLogger = { log: sinon.stub() }

            const blessedStub = {
                screen: sinon.stub().returns(mockScreen),
                text: sinon.stub(),
                log: sinon.stub().returns(mockLogger)
            }

            // docker logs spawn child
            const childStdout = new Readable({ read() {} })
            const childStderr = new Readable({ read() {} })
            const logChild = new EventEmitter()
            logChild.stdout = childStdout
            logChild.stderr = childStderr
            logChild.kill = sinon.stub()
            stubs.spawn.returns(logChild)

            const ds = proxyquire('../../src/services/DockerService', {
                'child_process': {
                    execFile: stubs.execFile,
                    spawn: stubs.spawn,
                    spawnSync: stubs.spawnSync
                },
                'fs': { readFileSync: sinon.stub(), mkdirSync: sinon.stub(), createWriteStream: sinon.stub() },
                'blessed': blessedStub
            })

            const containers = [
                { name: 'encoder', id: 'abc123' },
                { name: 'decoder', id: 'def456' }
            ]
            const promise = ds.startDockerMonitor(containers, true)

            // Verify blessed UI was set up
            expect(blessedStub.screen.calledOnce).to.be.true
            expect(blessedStub.log.called).to.be.true
            expect(stubs.spawn.called).to.be.true

            // Emit stdout/stderr data to cover those branches
            childStdout.emit('data', Buffer.from('log line'))
            childStderr.emit('data', Buffer.from('error line'))
            logChild.emit('error', new Error('child error'))

            // Trigger the q key handler to resolve
            expect(keyHandler).to.be.a('function')
            keyHandler()

            const result = await promise
            expect(result).to.be.true
            expect(mockScreen.destroy.calledOnce).to.be.true
        })

        it('spawns docker logs without -f flag when follow=false', async function () {
            const stubs = makeStubs()
            const EventEmitter = require('events')
            const { Readable } = require('stream')

            let keyHandler = null
            const mockScreen = {
                key: sinon.stub().callsFake((keys, handler) => { keyHandler = handler }),
                on: sinon.stub(),
                render: sinon.stub(),
                destroy: sinon.stub()
            }
            const mockLogger = { log: sinon.stub() }
            const blessedStub = {
                screen: sinon.stub().returns(mockScreen),
                text: sinon.stub(),
                log: sinon.stub().returns(mockLogger)
            }

            let spawnArgs = null
            const childStdout = new Readable({ read() {} })
            const childStderr = new Readable({ read() {} })
            const logChild = new EventEmitter()
            logChild.stdout = childStdout
            logChild.stderr = childStderr
            logChild.kill = sinon.stub()
            stubs.spawn.callsFake((cmd, args) => {
                spawnArgs = args
                return logChild
            })

            const ds = proxyquire('../../src/services/DockerService', {
                'child_process': { execFile: stubs.execFile, spawn: stubs.spawn, spawnSync: stubs.spawnSync },
                'fs': { readFileSync: sinon.stub(), mkdirSync: sinon.stub(), createWriteStream: sinon.stub() },
                'blessed': blessedStub
            })

            const promise = ds.startDockerMonitor([{ name: 'enc', id: 'abc123' }], false)
            keyHandler()
            await promise

            // follow=false → -f should NOT be in args (filtered out as null)
            expect(spawnArgs).to.not.include('-f')
        })
    })
})
