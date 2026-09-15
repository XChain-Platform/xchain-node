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
    return proxyquire('../../src/services/docker_service', {
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

function registerDockerReachabilityChecks() {
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

    it('checkBuildKitAvailable resolves when docker buildx version succeeds', async function () {
        const stubs = makeStubs()
        const seen = []
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            seen.push([cmd, ...args].join(' '))
            cb(null, 'github.com/docker/buildx v0.17.1 abc1234\n')
        })
        const ds = loadDockerService(stubs)
        expect(await ds.checkBuildKitAvailable()).to.be.true
        expect(seen).to.deep.equal(['docker buildx version'])
    })
}

function registerDockerReachabilityFailures() {
    it('checkBuildKitAvailable rejects with the install hint when buildx is missing', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            cb(new Error("docker: 'buildx' is not a docker command."))
        })
        const ds = loadDockerService(stubs)
        try {
            await ds.checkBuildKitAvailable()
            expect.fail('should have rejected')
        } catch (err) {
            expect(err).to.include('docker-buildx-plugin')
            expect(err).to.include('legacy builder')
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
}

describe('DockerService', function () {

    // checkDockerInstalledAndReachable
    describe('checkDockerInstalledAndReachable()', registerDockerReachabilityChecks)
    describe('checkDockerInstalledAndReachable()', registerDockerReachabilityFailures)

    // checkMemoryLimitSupport
    //
    // A kernel with no memory cgroup controller does not refuse `docker run
    // --memory`: it takes the flag, warns, and creates the container uncapped.
    // Docker says so in `docker info` warnings, which is the one cheap place to
    // ask before any container exists.
    describe('checkMemoryLimitSupport()', function () {

        // `answer` is what `docker info --format {{json .Warnings}}` prints.
        function load(answer, { dockerError } = {}) {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args[0]).to.equal('info')
                if (dockerError) { cb(new Error('daemon unreachable')); return }
                cb(null, answer)
            })
            return loadDockerService(stubs)
        }

        it('returns the warning when Docker says it cannot enforce a memory limit', async function () {
            const ds = load('["WARNING: No memory limit support","WARNING: No swap limit support"]\n')
            expect(await ds.checkMemoryLimitSupport()).to.equal('WARNING: No memory limit support')
        })

        it('returns null when the only shortfall is swap, which is survivable', async function () {
            const ds = load('["WARNING: No swap limit support"]\n')
            expect(await ds.checkMemoryLimitSupport()).to.be.null
        })

        it('returns null on a host with no warnings at all', async function () {
            expect(await load('[]\n').checkMemoryLimitSupport()).to.be.null
            expect(await load('null\n').checkMemoryLimitSupport()).to.be.null
        })

        it('returns null (best-effort) when docker info fails or answers nothing', async function () {
            expect(await load('', { dockerError: true }).checkMemoryLimitSupport()).to.be.null
            expect(await load('').checkMemoryLimitSupport()).to.be.null
        })

        it('returns null rather than throwing on output that is not JSON', async function () {
            expect(await load('not json at all\n').checkMemoryLimitSupport()).to.be.null
        })
    })
})
