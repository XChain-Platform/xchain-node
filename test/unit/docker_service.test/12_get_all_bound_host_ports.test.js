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

function loadDockerService(execFile) {
    return proxyquireDockerService(require.resolve('../../../src/services/docker_service'), {
        'child_process': { execFile, spawn: sinon.stub(), spawnSync: sinon.stub() },
        'util': { promisify: (fn) => fn },
        'fs': { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

// Answers `docker ps -a -q` with `ids` and `docker inspect` with `inspectOut`.
function dockerAnswering(ids, inspectOut) {
    return sinon.stub().callsFake((cmd, args, cb) => {
        expect(cmd).to.equal('docker')
        if (args[0] === 'ps') {
            expect(args).to.deep.equal(['ps', '-a', '-q'])
            return cb(null, ids)
        }
        expect(args[0]).to.equal('inspect')
        return cb(null, inspectOut)
    })
}

const STOPPED_TESTNET = '/xchain-node-bitcoin-testnet-xchain-utxo-tracker\t' +
    '{"3001/tcp":[{"HostIp":"","HostPort":"3101"}]}\n'

function registerBoundPortMappings() {
    it('reports the host ports saved in a stopped container\'s bindings', async function () {
        const execFile = dockerAnswering('aaa\nbbb\n',
            STOPPED_TESTNET + '/xchain-node-bitcoin-mainnet-xchain-utxo-tracker\t{"3001/tcp":[{"HostIp":"0.0.0.0","HostPort":"3001"}]}\n')
        const map = await loadDockerService(execFile).getAllBoundHostPorts()
        expect([...map.get('3101')]).to.deep.equal(['xchain-node-bitcoin-testnet-xchain-utxo-tracker'])
        expect([...map.get('3001')]).to.deep.equal(['xchain-node-bitcoin-mainnet-xchain-utxo-tracker'])
        expect(execFile.secondCall.args[1].slice(0, 3)).to.deep.equal(['inspect', '--format', '{{.Name}}\t{{json .HostConfig.PortBindings}}'])
        expect(execFile.secondCall.args[1].slice(3)).to.deep.equal(['aaa', 'bbb'])
    })

    it('skips null bindings and empty or non-numeric host ports', async function () {
        const execFile = dockerAnswering('aaa\nbbb\nccc\n',
            '/db\tnull\n/random\t{"80/tcp":[{"HostIp":"","HostPort":""}]}\n' +
            '/odd\t{"80/tcp":[{"HostIp":"","HostPort":"80-81"}],"90/tcp":null}\n')
        const map = await loadDockerService(execFile).getAllBoundHostPorts()
        expect(map.size).to.equal(0)
    })

    it('records two containers saving the same host port', async function () {
        const execFile = dockerAnswering('aaa\nbbb\n',
            '/one\t{"1/tcp":[{"HostPort":"4000"}]}\n/two\t{"1/tcp":[{"HostPort":"4000"}]}\n')
        const map = await loadDockerService(execFile).getAllBoundHostPorts()
        expect([...map.get('4000')].sort()).to.deep.equal(['one', 'two'])
    })
}

function registerBoundPortFallbacks() {
    it('returns an empty map without calling inspect when there are no containers', async function () {
        const execFile = dockerAnswering('\n', '')
        const map = await loadDockerService(execFile).getAllBoundHostPorts()
        expect(map.size).to.equal(0)
        expect(execFile.callCount).to.equal(1)
    })

    it('returns an empty map when docker fails (best-effort)', async function () {
        const execFile = sinon.stub().callsFake((cmd, args, cb) => cb(new Error('docker: not found')))
        const map = await loadDockerService(execFile).getAllBoundHostPorts()
        expect(map.size).to.equal(0)
    })

    it('skips an unparseable inspect line and keeps the rest', async function () {
        const execFile = dockerAnswering('aaa\nbbb\n', '/bad\t{not json\n' + STOPPED_TESTNET)
        const map = await loadDockerService(execFile).getAllBoundHostPorts()
        expect([...map.keys()]).to.deep.equal(['3101'])
    })
}

describe('DockerService', function () {
    describe('getAllBoundHostPorts()', registerBoundPortMappings)
    describe('getAllBoundHostPorts()', registerBoundPortFallbacks)
})
