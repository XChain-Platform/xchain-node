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

function registerLogContainerRawMode() {
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
}

function registerLogContainerEscapeKey() {
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
}

function registerLogContainerInterruptKey() {
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
}

describe('DockerService', function () {

    // logContainer: TTY + keypress branches
    describe('logContainer(): TTY keypress branches', registerLogContainerRawMode)
    describe('logContainer(): TTY keypress branches', registerLogContainerEscapeKey)
    describe('logContainer(): TTY keypress branches', registerLogContainerInterruptKey)
})

