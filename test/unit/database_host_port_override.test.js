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

const { expect, VALID_CONTAINER_ID, makeStubs, loadDatabaseService } = require('./database_service.test/helpers/harness')

function findDockerRunArgs(execFileAsync) {
    const call = execFileAsync.getCalls().find(({ args }) =>
        args[0] === 'docker' && Array.isArray(args[1]) && args[1][0] === 'run')
    return call ? call.args[1] : null
}

describe('database host port override', function () {
    let savedHostPort

    beforeEach(function () {
        savedHostPort = process.env.XCHAIN_NODE_DB_HOST_PORT
    })

    afterEach(function () {
        if (savedHostPort === undefined) delete process.env.XCHAIN_NODE_DB_HOST_PORT
        else process.env.XCHAIN_NODE_DB_HOST_PORT = savedHostPort
    })

    it('publishes MariaDB on XCHAIN_NODE_DB_HOST_PORT and checks that port for conflicts', async function () {
        process.env.XCHAIN_NODE_DB_HOST_PORT = '23306'
        const stubs = makeStubs()
        stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
        stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
        const service = loadDatabaseService(stubs)

        await service.buildDatabaseModule('bitcoin', 'mainnet')

        expect(findDockerRunArgs(stubs.execFileAsync)).to.include('127.0.0.1:23306:3306')
        expect(stubs.assertNoHostPortConflicts.calledWith(
            ['-p', '127.0.0.1:23306:3306'], 'xchain-node-database'
        )).to.be.true
    })

    it('uses the override as the fallback connection port when Docker cannot report the binding', async function () {
        process.env.XCHAIN_NODE_DB_HOST_PORT = '23307'
        const stubs = makeStubs()
        stubs.execFileAsync.rejects(new Error('docker unavailable'))
        const service = loadDatabaseService(stubs)

        expect(await service.getDatabaseHostPort()).to.equal(23307)
    })

    it('rejects an invalid override before docker run', async function () {
        process.env.XCHAIN_NODE_DB_HOST_PORT = 'not-a-port'
        const stubs = makeStubs()
        stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
        stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
        const service = loadDatabaseService(stubs)

        let error
        try {
            await service.buildDatabaseModule('bitcoin', 'mainnet')
        } catch (err) {
            error = err
        }

        expect(error).to.be.an.instanceOf(Error)
        expect(error.message).to.include('XCHAIN_NODE_DB_HOST_PORT=not-a-port')
        expect(findDockerRunArgs(stubs.execFileAsync)).to.be.null
    })
})
