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

const { sinon, expect, VALID_CONTAINER_ID, mariadbAttempts, makeStubs, loadDatabaseService } = require('./helpers/harness')

// Answer `docker inspect` with the container id (or `inspect(n)`'s answer on the nth
// inspect) and every mariadb ping with `ping(n)` on the nth ping.
function answerDocker(stubs, { ping = () => true, inspect = () => VALID_CONTAINER_ID } = {}) {
    let inspects = 0
    let pings = 0
    stubs.execFileAsync.callsFake(async (cmd, args) => {
        if (args[0] === 'inspect') {
            const id = inspect(++inspects)
            if (!id) throw new Error('Error: No such container: xchain-node-database')
            return { stdout: id + '\n' }
        }
        if (Array.isArray(args) && args.includes('mariadb')) {
            if (ping(++pings)) return { stdout: '1\n' }
            throw new Error('ERROR 2002 (HY000): Can\'t connect to local server through socket')
        }
        return { stdout: '' }
    })
}

function registerAnswerTests() {
    it('returns true when database responds', async function () {
        const stubs = makeStubs()
        answerDocker(stubs)
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('root', 'rootpass')).to.be.true
    })

    it('passes -D database arg when database is specified', async function () {
        const stubs = makeStubs()
        answerDocker(stubs)
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('root', 'rootpass', 'xchain_node')).to.be.true
        const dockerCall = mariadbAttempts(stubs)[0]
        expect(dockerCall.args[1]).to.include('-D')
        expect(dockerCall.args[1]).to.include('xchain_node')
        expect(dockerCall.args[1]).to.include(VALID_CONTAINER_ID)
    })

    it('passes the password via MYSQL_PWD env, never in argv', async function () {
        const stubs = makeStubs()
        answerDocker(stubs)
        const ds = loadDatabaseService(stubs)
        await ds.checkIfDatabaseIsReady('root', 's3cret-pw')
        const dockerCall = mariadbAttempts(stubs)[0]
        expect(dockerCall.args[1]).to.include('MYSQL_PWD')
        expect(dockerCall.args[1].some(a => String(a).includes('s3cret-pw'))).to.be.false
        expect(dockerCall.args[2].env.MYSQL_PWD).to.equal('s3cret-pw')
    })
}

function registerBudgetTests() {
    it('retries a server that is still starting and succeeds once it answers', async function () {
        const stubs = makeStubs()
        answerDocker(stubs, { ping: (n) => n >= 3 })
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('root', 'rootpass')).to.be.true
        expect(mariadbAttempts(stubs)).to.have.length(3)
    })

    // The 10x10s budget belongs to the post-`docker run` readiness wait. A
    // caller asking "do these credentials still work" gets a PERMANENT answer,
    // so it must be able to buy a shorter budget than ~100s of sleeps.
    it('honours a caller-supplied retry budget', async function () {
        const stubs = makeStubs()
        answerDocker(stubs, { ping: () => false })
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('u', 'p', 'xchain_node', { tries: 2, retryDelay: 1 })).to.be.false
        expect(mariadbAttempts(stubs)).to.have.length(2)
    })

    it('still spends the full readiness budget when the caller passes none', async function () {
        const stubs = makeStubs()
        answerDocker(stubs, { ping: () => false })
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('root', 'rootpass')).to.be.false
        expect(mariadbAttempts(stubs)).to.have.length(10)
    })
}

function registerContainerLookupTests() {
    it('looks the container up again on every attempt, so one missed inspect does not spend the budget', async function () {
        const stubs = makeStubs()
        answerDocker(stubs, { inspect: (n) => (n <= 2 ? null : VALID_CONTAINER_ID) })
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('root', 'rootpass')).to.be.true
        expect(mariadbAttempts(stubs)).to.have.length(1)
        expect(mariadbAttempts(stubs)[0].args[1]).to.include(VALID_CONTAINER_ID)
    })

    it('never execs against a missing container, and gives up after the budget', async function () {
        const stubs = makeStubs()
        answerDocker(stubs, { inspect: () => null })
        const ds = loadDatabaseService(stubs)
        expect(await ds.checkIfDatabaseIsReady('root', 'rootpass', null, { tries: 3, retryDelay: 1 })).to.be.false
        expect(mariadbAttempts(stubs)).to.have.length(0)
    })
}

describe('DatabaseService', function () {
    afterEach(() => sinon.restore())
    describe('checkIfDatabaseIsReady()', function () {
        registerAnswerTests()
        registerBudgetTests()
        registerContainerLookupTests()
    })
})
