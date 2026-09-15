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

// Helper: stub `docker info` to return a data-root, and fs.statSync to
// report a device id per path so we can simulate cross-filesystem layouts.
function load(dockerRootDir, devByPath, { dockerError } = {}) {
    const stubs = makeStubs()
    stubs.execFile.callsFake((cmd, args, ...rest) => {
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        expect(cmd).to.equal('docker')
        expect(args[0]).to.equal('info')
        expect(args).to.include('--format')
        if (dockerError) { cb(new Error('daemon unreachable')); return }
        cb(null, dockerRootDir === null ? '' : dockerRootDir + '\n')
    })
    const fsStub = {
        readFileSync: sinon.stub(),
        statSync: (p) => {
            if (!(p in devByPath)) {
                const err = new Error('ENOENT: ' + p)
                err.code = 'ENOENT'
                throw err
            }
            return { dev: devByPath[p] }
        }
    }
    return loadDockerService(stubs, fsStub)
}

const ORIG_ENV = process.env.XCHAIN_NODE_CONTAINERD_ROOT

function registerContainerdDeviceChecks() {
    afterEach(function () {
        if (ORIG_ENV === undefined) delete process.env.XCHAIN_NODE_CONTAINERD_ROOT
        else process.env.XCHAIN_NODE_CONTAINERD_ROOT = ORIG_ENV
    })

    it('warns when data-root moved off / but containerd is still on /', async function () {
        // `/` = dev 1, data-root on dev 2 (moved), containerd still on dev 1.
        const ds = load('/misc/docker', { '/': 1, '/misc/docker': 2, '/var/lib/containerd': 1 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.deep.equal({ dockerRootDir: '/misc/docker', containerdRoot: '/var/lib/containerd' })
    })

    it('returns null when data-root is still on the root filesystem', async function () {
        const ds = load('/var/lib/docker', { '/': 1, '/var/lib/docker': 1, '/var/lib/containerd': 1 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })

    it('returns null when containerd was also relocated off / (same disk as data-root)', async function () {
        const ds = load('/misc/docker', { '/': 1, '/misc/docker': 2, '/var/lib/containerd': 2 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })
}

function registerContainerdFallbackChecks() {
    afterEach(function () {
        if (ORIG_ENV === undefined) delete process.env.XCHAIN_NODE_CONTAINERD_ROOT
        else process.env.XCHAIN_NODE_CONTAINERD_ROOT = ORIG_ENV
    })

    it('returns null when containerd lives on a third off-root disk', async function () {
        const ds = load('/misc/docker', { '/': 1, '/misc/docker': 2, '/var/lib/containerd': 3 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })

    it('honors XCHAIN_NODE_CONTAINERD_ROOT override', async function () {
        process.env.XCHAIN_NODE_CONTAINERD_ROOT = '/data/containerd'
        const ds = load('/misc/docker', { '/': 1, '/misc/docker': 2, '/data/containerd': 1 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.deep.equal({ dockerRootDir: '/misc/docker', containerdRoot: '/data/containerd' })
    })

    it('returns null when the containerd path does not exist', async function () {
        // data-root moved off /, but /var/lib/containerd is absent → nothing to warn.
        const ds = load('/misc/docker', { '/': 1, '/misc/docker': 2 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })
}

function registerContainerdErrorChecks() {
    afterEach(function () {
        if (ORIG_ENV === undefined) delete process.env.XCHAIN_NODE_CONTAINERD_ROOT
        else process.env.XCHAIN_NODE_CONTAINERD_ROOT = ORIG_ENV
    })

    it('returns null when the data-root path is unreadable', async function () {
        const ds = load('/misc/docker', { '/': 1, '/var/lib/containerd': 1 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })

    it('returns null (best-effort) when docker info fails', async function () {
        const ds = load('/misc/docker', { '/': 1 }, { dockerError: true })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })

    it('returns null when docker info returns an empty data-root', async function () {
        const ds = load(null, { '/': 1 })
        const result = await ds.checkContainerdDataRootRelocation()
        expect(result).to.be.null
    })
}

describe('DockerService', function () {

    // checkContainerdDataRootRelocation
    describe('checkContainerdDataRootRelocation()', registerContainerdDeviceChecks)
    describe('checkContainerdDataRootRelocation()', registerContainerdFallbackChecks)
    describe('checkContainerdDataRootRelocation()', registerContainerdErrorChecks)
})

describe('DockerService', function () {


    // Container lifecycle commands
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
})
