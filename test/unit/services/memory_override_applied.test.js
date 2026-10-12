'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const {
    makeNodeServiceStubs,
    loadNodeService
} = require('../node_service.test/support/helpers')
const {
    makeStubs,
    loadDatabaseService,
    VALID_CONTAINER_ID
} = require('../database_service.test/helpers/harness')

function dockerRunArgs(execFile) {
    const call = execFile.getCalls().find(candidate =>
        candidate.args[0] === 'docker' &&
        Array.isArray(candidate.args[1]) &&
        candidate.args[1][0] === 'run')
    return call && call.args[1]
}

describe('container memory overrides', function () {
    const envNames = [
        'XCHAIN_NODE_MODULE_MEMORY_MB_NODE',
        'XCHAIN_NODE_MODULE_MEMORY_MB_DATABASE',
        'XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_DATABASE'
    ]
    let savedEnv

    beforeEach(function () {
        savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
        for (const name of envNames) delete process.env[name]
    })

    afterEach(function () {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('puts the node override in the docker run argv', async function () {
        process.env.XCHAIN_NODE_MODULE_MEMORY_MB_NODE = '768'
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((command, args, options, callback) => {
            if (args[0] === 'build') return callback(null)
            if (args[0] === 'run') return callback(null, VALID_CONTAINER_ID + '\n')
        })

        await loadNodeService(stubs).buildCryptoNode('bitcoin', 'mainnet')

        const args = dockerRunArgs(stubs.execFile)
        const memoryIndex = args.indexOf('--memory')
        expect(args.slice(memoryIndex, memoryIndex + 4)).to.deep.equal([
            '--memory', '768m', '--memory-swap', '768m'
        ])
        expect(memoryIndex).to.be.lessThan(args.lastIndexOf('xchain-node-bitcoin-mainnet-node'))
        expect(stubs.execFile.getCalls().some(call => call.args[1][0] === 'update')).to.be.false
    })

    it('puts the database override and stop timeout in the MariaDB docker run argv', async function () {
        process.env.XCHAIN_NODE_MODULE_MEMORY_MB_DATABASE = '1024'
        process.env.XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_DATABASE = '47'
        const stubs = makeStubs()
        stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
        stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })

        await loadDatabaseService(stubs).buildDatabaseModule('bitcoin', 'mainnet')

        const args = dockerRunArgs(stubs.execFileAsync)
        const memoryIndex = args.indexOf('--memory')
        const timeoutIndex = args.indexOf('--stop-timeout')
        expect(args.slice(memoryIndex, memoryIndex + 4)).to.deep.equal([
            '--memory', '1024m', '--memory-swap', '1024m'
        ])
        expect(args.slice(timeoutIndex, timeoutIndex + 2)).to.deep.equal(['--stop-timeout', '47'])
        expect(memoryIndex).to.be.lessThan(args.lastIndexOf('xchain-node-database'))
        expect(timeoutIndex).to.be.lessThan(args.lastIndexOf('xchain-node-database'))
    })
})
