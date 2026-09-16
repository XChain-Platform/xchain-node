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
const { proxyquireDockerService } = require('../../helpers/docker_service_loader')

// Helpers
function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquireDockerService(require.resolve('../../../src/services/docker_service'), {
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

function registerContainerFileWrites() {
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
}

function registerContainerFileSpawnFailure() {
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
}

describe('DockerService', function () {

    // stringToDockerContainerFile
    describe('stringToDockerContainerFile()', registerContainerFileWrites)
    describe('stringToDockerContainerFile()', registerContainerFileSpawnFailure)
})

function registerContainerLogSaveSuccess() {
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
}

function registerContainerLogSaveFailure() {
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
}

describe('DockerService', function () {

    // saveContainerLogs
    describe('saveContainerLogs()', registerContainerLogSaveSuccess)
    describe('saveContainerLogs()', registerContainerLogSaveFailure)
})

