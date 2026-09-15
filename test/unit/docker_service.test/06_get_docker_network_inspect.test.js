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
})


describe('DockerService', function () {


    // Container interaction
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
})

