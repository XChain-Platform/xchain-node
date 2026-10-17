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

const { sinon, expect, VALID_CONTAINER_ID, makeStubs, loadDatabaseService } = require('../helpers/harness')
const { resolveBufferPoolSize, DEFAULT_BUFFER_POOL_SIZE } = require('../../../../src/services/database_service/buffer_pool_size')

// The mysqld args buildDatabaseModule hands `docker run` for a given env value
// (undefined leaves the variable unset).
async function runArgsWithPoolEnv(value) {
    const saved = process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE
    if (value === undefined) delete process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE
    else process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE = value
    try {
        const stubs = makeStubs()
        stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
        stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
        await loadDatabaseService(stubs).buildDatabaseModule('bitcoin', 'mainnet')
        const call = stubs.execFileAsync.getCalls().find(c =>
            c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
        expect(call, 'docker run call not found').to.exist
        return call.args[1]
    } finally {
        if (saved === undefined) delete process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE
        else process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE = saved
    }
}

describe('resolveBufferPoolSize()', function () {
    it('defaults to 1G when the variable is unset or blank', function () {
        const warn = sinon.spy()
        expect(DEFAULT_BUFFER_POOL_SIZE).to.equal('1G')
        for (const raw of [undefined, null, '', '   ']) expect(resolveBufferPoolSize(raw, warn)).to.equal('1G')
        expect(warn.called).to.be.false
    })

    it('accepts a byte count with an optional K, M or G suffix', function () {
        const warn = sinon.spy()
        for (const raw of ['134217728', '512K', '512M', '16G', ' 2G ']) {
            expect(resolveBufferPoolSize(raw, warn)).to.equal(raw.trim())
        }
        expect(warn.called).to.be.false
    })

    it('falls back to the default with a warning naming the bad value', function () {
        for (const raw of ['16GB', '1.5G', 'big', '-1G', '16g', '1G;--evil', 'G']) {
            const warn = sinon.spy()
            expect(resolveBufferPoolSize(raw, warn), raw).to.equal('1G')
            expect(warn.calledOnce, raw).to.be.true
            expect(warn.firstCall.args[0]).to.include(raw.trim())
        }
    })
})

describe('DatabaseService buffer pool argument', function () {
    it('passes --innodb-buffer-pool-size=1G after the image when the variable is unset', async function () {
        const runArgs = await runArgsWithPoolEnv(undefined)
        expect(runArgs.indexOf('--innodb-buffer-pool-size=1G')).to.be.greaterThan(runArgs.indexOf('xchain-node-database'))
        expect(runArgs.filter(a => String(a).startsWith('--innodb-buffer-pool-size'))).to.have.lengthOf(1)
    })

    it('passes the operator value when it is valid', async function () {
        const runArgs = await runArgsWithPoolEnv('512M')
        expect(runArgs).to.include('--innodb-buffer-pool-size=512M')
        expect(runArgs).to.not.include('--innodb-buffer-pool-size=1G')
    })

    it('passes the default when the value is malformed', async function () {
        const runArgs = await runArgsWithPoolEnv('lots')
        expect(runArgs).to.include('--innodb-buffer-pool-size=1G')
        expect(runArgs.some(a => String(a).includes('lots'))).to.be.false
    })

    it('does not add the flush-log setting', async function () {
        const runArgs = await runArgsWithPoolEnv(undefined)
        expect(runArgs.some(a => String(a).startsWith('--innodb-flush-log-at-trx-commit'))).to.be.false
    })
})
