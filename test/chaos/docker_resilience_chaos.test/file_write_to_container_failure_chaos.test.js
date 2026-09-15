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

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment: stringToDockerContainerFile with broken spawn
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
    })
})

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment: File write to container failure', function () {

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
})
