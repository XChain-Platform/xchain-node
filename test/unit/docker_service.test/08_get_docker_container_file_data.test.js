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

describe('DockerService', function () {


    // File transfer
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
})


describe('DockerService', function () {


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
})

