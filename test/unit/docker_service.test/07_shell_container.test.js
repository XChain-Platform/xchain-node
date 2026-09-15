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

describe('DockerService', function () {


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
})


describe('DockerService', function () {


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
})

