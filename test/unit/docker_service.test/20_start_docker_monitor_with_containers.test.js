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

// Helpers
function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquire('../../../src/services/docker_service', {
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

function makeMonitorFixture(stubs, setKeyHandler) {
    const EventEmitter = require('events')
    const { Readable } = require('stream')

    // Set up mock children for docker logs spawn
    const mockScreen = {
        key: sinon.stub().callsFake((keys, handler) => { setKeyHandler(handler) }),
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

    // Set up mock children for docker logs spawn
    const childStdout = new Readable({ read() {} })
    const childStderr = new Readable({ read() {} })
    const logChild = new EventEmitter()
    logChild.stdout = childStdout
    logChild.stderr = childStderr
    logChild.kill = sinon.stub()
    stubs.spawn.returns(logChild)
    return { mockScreen, blessedStub, childStdout, childStderr, logChild }
}

function registerMonitorUiExit() {
    it('sets up blessed UI, spawns docker logs for each container, resolves on q key', async function () {
        const stubs = makeStubs()
        let keyHandler = null
        const setKeyHandler = (handler) => { keyHandler = handler }
        const fixture = makeMonitorFixture(stubs, setKeyHandler)
        const { mockScreen, blessedStub, childStdout, childStderr, logChild } = fixture

        const ds = proxyquire('../../../src/services/docker_service', {
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
}

function registerMonitorTruncationWarning() {
    it('warns and names omitted containers plus labels banner "n of N" when more than MAX_CONTAINERS are requested', async function () {
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
        let bannerContent = null
        const blessedStub = {
            screen: sinon.stub().returns(mockScreen),
            text: sinon.stub().callsFake((opts) => { bannerContent = opts.content }),
            log: sinon.stub().returns(mockLogger)
        }

        const childStdout = new Readable({ read() {} })
        const childStderr = new Readable({ read() {} })
        const logChild = new EventEmitter()
        logChild.stdout = childStdout
        logChild.stderr = childStderr
        logChild.kill = sinon.stub()
        stubs.spawn.returns(logChild)

        const logSpy = sinon.spy(console, 'log')
        try {
            const ds = proxyquire('../../../src/services/docker_service', {
                'child_process': { execFile: stubs.execFile, spawn: stubs.spawn, spawnSync: stubs.spawnSync },
                'fs': { readFileSync: sinon.stub(), mkdirSync: sinon.stub(), createWriteStream: sinon.stub() },
                'blessed': blessedStub
            })

            // 8 containers: first 6 monitored, node7/node8 must be named as omitted
            const containers = []
            for (let i = 1; i <= 8; i++) {
                containers.push({ name: 'node' + i, id: 'id' + i })
            }
            const promise = ds.startDockerMonitor(containers, true)

            const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
            expect(warned).to.match(/omitted:.*node7/)
            expect(warned).to.match(/node8/)
            expect(warned).to.match(/6 of 8/)
            // Only MAX_CONTAINERS panes rendered
            expect(blessedStub.log.callCount).to.equal(6)
            // Banner discloses truncation
            expect(bannerContent).to.contain('6 of 8')

            keyHandler()
            await promise
        } finally {
            logSpy.restore()
        }
    })
}

function registerMonitorPlainBanner() {
    it('does not warn and keeps the plain banner when at most MAX_CONTAINERS are requested', async function () {
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
        let bannerContent = null
        const blessedStub = {
            screen: sinon.stub().returns(mockScreen),
            text: sinon.stub().callsFake((opts) => { bannerContent = opts.content }),
            log: sinon.stub().returns(mockLogger)
        }

        const childStdout = new Readable({ read() {} })
        const childStderr = new Readable({ read() {} })
        const logChild = new EventEmitter()
        logChild.stdout = childStdout
        logChild.stderr = childStderr
        logChild.kill = sinon.stub()
        stubs.spawn.returns(logChild)

        const logSpy = sinon.spy(console, 'log')
        try {
            const ds = proxyquire('../../../src/services/docker_service', {
                'child_process': { execFile: stubs.execFile, spawn: stubs.spawn, spawnSync: stubs.spawnSync },
                'fs': { readFileSync: sinon.stub(), mkdirSync: sinon.stub(), createWriteStream: sinon.stub() },
                'blessed': blessedStub
            })

            const containers = [
                { name: 'encoder', id: 'abc123' },
                { name: 'decoder', id: 'def456' }
            ]
            const promise = ds.startDockerMonitor(containers, true)

            const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
            expect(warned).to.not.match(/omitted/)
            expect(bannerContent).to.equal(' Monitoring 2 containers (Q - Exit) ')

            keyHandler()
            await promise
        } finally {
            logSpy.restore()
        }
    })
}

function registerMonitorWithoutFollow() {
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

        const ds = proxyquire('../../../src/services/docker_service', {
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
}

describe('DockerService', function () {

    // startDockerMonitor: with containers (blessed UI)
    describe('startDockerMonitor(): with containers', registerMonitorUiExit)
    describe('startDockerMonitor(): with containers', registerMonitorTruncationWarning)
    describe('startDockerMonitor(): with containers', registerMonitorPlainBanner)
    describe('startDockerMonitor(): with containers', registerMonitorWithoutFollow)
})

