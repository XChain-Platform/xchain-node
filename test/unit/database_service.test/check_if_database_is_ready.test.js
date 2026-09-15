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

const { sinon, expect, VALID_CONTAINER_ID, fakeSpawn, mariadbAttempts, makeStubs, loadDatabaseService } = require('./helpers/harness')

describe('DatabaseService', function () {

        describe('checkIfDatabaseIsReady()', function () {

        it('returns true when database responds', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'rootpass')
            expect(result).to.be.true
        })

        it('retries up to 10 times then returns false', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('connection refused'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'badpass')
            expect(result).to.be.false
        })

        it('passes -D database arg when database is specified', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'rootpass', 'xchain_node')
            expect(result).to.be.true
            const dockerCall = stubs.execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1].includes('mariadb'))
            expect(dockerCall.args[1]).to.include('-D')
            expect(dockerCall.args[1]).to.include('xchain_node')
        })

        it('passes the password via MYSQL_PWD env, never in argv', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            await ds.checkIfDatabaseIsReady('root', 's3cret-pw')
            const dockerCall = stubs.execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1].includes('mariadb'))
            expect(dockerCall.args[1]).to.include('MYSQL_PWD')
            expect(dockerCall.args[1].some(a => String(a).includes('s3cret-pw'))).to.be.false
            expect(dockerCall.args[2].env.MYSQL_PWD).to.equal('s3cret-pw')
        })


        // The 10x10s budget belongs to the post-`docker run` readiness wait. A
        // caller asking "do these credentials still work" gets a PERMANENT answer,
        // so it must be able to buy a shorter budget than ~100s of sleeps.
        it('honours a caller-supplied retry budget', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('ERROR 1045 (28000): Access denied for user'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('u', 'p', 'xchain_node', { tries: 2, retryDelay: 1 })
            expect(result).to.be.false
            expect(mariadbAttempts(stubs)).to.have.length(2)
        })
        })
})

describe('DatabaseService', function () {

        describe('checkIfDatabaseIsReady()', function () {

        it('still spends the full readiness budget when the caller passes none', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('connection refused'))
            const ds = loadDatabaseService(stubs)
            expect(await ds.checkIfDatabaseIsReady('root', 'rootpass')).to.be.false
            expect(mariadbAttempts(stubs)).to.have.length(10)
        })
        })
})
