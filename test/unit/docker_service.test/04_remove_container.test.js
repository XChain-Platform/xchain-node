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
})


describe('DockerService', function () {


    // uuid:8a3e5182. A caller about to DELETE a stateful container needs positive
    // evidence of absence, and every other lookup here answers falsy for "absent",
    // "daemon hiccup" and "unparseable payload" alike. Only docker's own
    // "no such container" may read as gone.
    describe('probeContainerPresenceByName()', function () {
        function probeWith(handler) {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['inspect', '--type', 'container', '--format', '{{.Id}}', 'xchain-node-database'])
                handler(cb)
            })
            return loadDockerService(stubs).probeContainerPresenceByName('xchain-node-database')
        }

        const ID = 'a'.repeat(64)

        it("reports 'exists' on a clean 64-hex id", async function () {
            expect(await probeWith(cb => cb(null, ID + '\n', ''))).to.equal('exists')
        })

        it("reports 'gone' only when docker says no such container", async function () {
            expect(await probeWith(cb => {
                cb(new Error('Command failed'), '', 'Error: No such object: xchain-node-database\n')
            })).to.equal('gone')
        })

        it("reports 'unknown' when the daemon is unreachable", async function () {
            expect(await probeWith(cb => {
                cb(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), '',
                   'Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
            })).to.equal('unknown')
        })

        it("reports 'unknown' on a timeout, which carries no absence evidence", async function () {
            expect(await probeWith(cb => {
                const err = new Error('spawn ETIMEDOUT')
                err.killed = true
                cb(err, '', '')
            })).to.equal('unknown')
        })

        it("reports 'unknown' on a clean exit that yielded no id", async function () {
            expect(await probeWith(cb => cb(null, 'Warning: something\n', ''))).to.equal('unknown')
        })
    })
})

