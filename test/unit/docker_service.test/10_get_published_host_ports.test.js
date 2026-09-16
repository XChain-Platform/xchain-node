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

function stubPs(stubs, output) {
    stubs.execFile.callsFake((cmd, args, ...rest) => {
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        expect(cmd).to.equal('docker')
        expect(args[0]).to.equal('ps')
        expect(args).to.include('--format')
        cb(null, output)
    })
}

function registerPublishedPortMappings() {
    it('maps host ports to the containers publishing them (0.0.0.0 + :::)', async function () {
        const stubs = makeStubs()
        stubPs(stubs,
            'xchain-node-explorer\t0.0.0.0:80->8080/tcp, :::80->8080/tcp, 0.0.0.0:443->8443/tcp, :::443->8443/tcp\n' +
            'xchain-node-bitcoin-mainnet-xchain-indexer\t0.0.0.0:4010->4010/tcp\n'
        )
        const ds = loadDockerService(stubs)
        const map = await ds.getPublishedHostPorts()
        expect([...map.get('80')]).to.deep.equal(['xchain-node-explorer'])
        expect([...map.get('443')]).to.deep.equal(['xchain-node-explorer'])
        expect([...map.get('4010')]).to.deep.equal(['xchain-node-bitcoin-mainnet-xchain-indexer'])
    })

    it('records multiple containers contending for the same host port', async function () {
        const stubs = makeStubs()
        stubPs(stubs,
            'stackA-explorer\t0.0.0.0:80->8080/tcp\n' +
            'stackB-explorer\t0.0.0.0:80->8080/tcp\n'
        )
        const ds = loadDockerService(stubs)
        const map = await ds.getPublishedHostPorts()
        expect([...map.get('80')].sort()).to.deep.equal(['stackA-explorer', 'stackB-explorer'])
    })

    it('ignores exposed-but-unpublished ports (no "->")', async function () {
        const stubs = makeStubs()
        stubPs(stubs, 'some-db\t3306/tcp\n')
        const ds = loadDockerService(stubs)
        const map = await ds.getPublishedHostPorts()
        expect(map.size).to.equal(0)
    })
}

function registerPublishedPortFallbacks() {
    it('parses host-IP-scoped bindings (127.0.0.1:13306->3306)', async function () {
        const stubs = makeStubs()
        stubPs(stubs, 'xchain-node-database\t127.0.0.1:13306->3306/tcp\n')
        const ds = loadDockerService(stubs)
        const map = await ds.getPublishedHostPorts()
        expect([...map.get('13306')]).to.deep.equal(['xchain-node-database'])
    })

    it('returns an empty map when docker ps fails (best-effort)', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            cb(new Error('docker daemon unreachable'))
        })
        const ds = loadDockerService(stubs)
        const map = await ds.getPublishedHostPorts()
        expect(map.size).to.equal(0)
    })

    it('returns an empty map when there are no running containers', async function () {
        const stubs = makeStubs()
        stubPs(stubs, '')
        const ds = loadDockerService(stubs)
        const map = await ds.getPublishedHostPorts()
        expect(map.size).to.equal(0)
    })
}

describe('DockerService', function () {

    // getPublishedHostPorts
    describe('getPublishedHostPorts()', registerPublishedPortMappings)
    describe('getPublishedHostPorts()', registerPublishedPortFallbacks)
})

describe('DockerService', function () {


    // waitContainer
    describe('waitContainer()', function () {

        it('runs docker wait and returns parsed exit code', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['wait', 'abc123'])
                cb(null, '0\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.waitContainer('abc123')
            expect(result).to.equal(0)
        })

        it('returns non-zero exit code', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '1\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.waitContainer('abc123')
            expect(result).to.equal(1)
        })

        it('rejects on error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('wait failed'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.waitContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })
})

