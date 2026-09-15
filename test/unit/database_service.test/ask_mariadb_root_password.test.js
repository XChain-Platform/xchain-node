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

        describe('askMariadbRootPassword()', function () {

        it('returns cached password immediately', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns('cached-pass')
            const ds = loadDatabaseService(stubs)
            const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
            expect(result).to.equal('cached-pass')
        })

        it('reads from external DB config when EXTERNAL_DB=true and not cached', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.mariadb._fakeConn.query.resolves([])

            const saved = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
                XCHAIN_NODE_EXTERNAL_DB_PORT:          process.env.XCHAIN_NODE_EXTERNAL_DB_PORT,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
            }
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = '127.0.0.1'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3306'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'root'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'external-root-pass'
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('external-root-pass')
                expect(stubs.setDbRootPassword.calledWith('external-root-pass')).to.be.true
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('askMariadbRootPassword()', function () {

        it('reads from XCHAIN_NODE_DB_ROOT_PASSWORD env var when not cached and no container is running', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'env-root-pass'
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                // No container up yet (fresh install): checkIfDatabaseModuleExists ->
                // getDatabaseContainerId's inspect call resolves a non-hex id, so it
                // returns null and there is nothing to verify the env override
                // against; it must be accepted as-is (uuid:2c5ec698).
                stubs.execFileAsync.resolves({ stdout: 'Error: No such object\n' })
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('env-root-pass')
                expect(stubs.setDbRootPassword.calledWith('env-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('verifies XCHAIN_NODE_DB_ROOT_PASSWORD against a running container before trusting it', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'env-root-pass'
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                // Container IS running: inspect finds it, then the env password
                // must be verified with a ping before being trusted.
                stubs.execFileAsync
                    .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' }) // getDatabaseContainerId (inspect)
                    .onCall(1).resolves({ stdout: 'mysqld is alive\n' })       // ping with the env password
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('env-root-pass')
                expect(stubs.setDbRootPassword.calledWith('env-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('askMariadbRootPassword()', function () {

        it('falls through to the container-env read when XCHAIN_NODE_DB_ROOT_PASSWORD does not verify', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'stale-env-pass'
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                stubs.execFileAsync
                    .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })    // getDatabaseContainerId (inspect)
                    .onCall(1).resolves({ stdout: 'Access denied\n' })           // ping with the stale env password: fails
                    .onCall(2).resolves({ stdout: 'container-root-pass\n' })     // docker exec printenv
                    .onCall(3).resolves({ stdout: 'mysqld is alive\n' })         // ping with the container's real password
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('container-root-pass')
                expect(stubs.setDbRootPassword.calledWith('container-root-pass')).to.be.true
                expect(stubs.setDbRootPassword.calledWith('stale-env-pass')).to.be.false
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })


        // The fall-through is right, the silence is not: an operator who set the
        // variable believes it IS the credential in force, so a mid-rotation
        // divergence has to be named where it happens (uuid:aa6c2267).
        it('warns, without printing a value, when the env override does not authenticate', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'stale-env-pass'
            const warned = []
            const warnStub = sinon.stub(console, 'warn').callsFake((...args) => warned.push(args.join(' ')))
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                stubs.execFileAsync
                    .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                    .onCall(1).rejects(new Error('Access denied for user root'))
                    .onCall(2).resolves({ stdout: 'container-root-pass\n' })
                    .onCall(3).resolves({ stdout: 'mysqld is alive\n' })
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('container-root-pass')
                const output = warned.join('\n')
                expect(output).to.include('XCHAIN_NODE_DB_ROOT_PASSWORD')
                expect(output).to.include('MYSQL_ROOT_PASSWORD')
                expect(output).to.not.include('stale-env-pass')
                expect(output).to.not.include('container-root-pass')
            } finally {
                warnStub.restore()
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('askMariadbRootPassword()', function () {

        it('stays silent when the env override authenticates', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'env-root-pass'
            const warned = []
            const warnStub = sinon.stub(console, 'warn').callsFake((...args) => warned.push(args.join(' ')))
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                stubs.execFileAsync
                    .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                    .onCall(1).resolves({ stdout: 'mysqld is alive\n' })
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('env-root-pass')
                expect(warned.join('\n')).to.not.include('XCHAIN_NODE_DB_ROOT_PASSWORD')
            } finally {
                warnStub.restore()
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('reads root password from running container printenv', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            // Flow (no env var XCHAIN_NODE_DB_ROOT_PASSWORD set):
            //   1. checkIfDatabaseModuleExists -> getDatabaseContainerId -> execFileAsync call 0 (inspect)
            //   2. getStatusFromContainer returns { State: { Status: 'running' } } -> dbContainerId found
            //   3. execFileAsync call 1 (docker exec printenv) -> 'container-root-pass\n'
            //   4. execFileAsync call 2 (docker exec mariadb-admin ping) -> 'mysqld is alive\n'
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).resolves({ stdout: 'container-root-pass\n' })    // docker exec printenv
                .onCall(2).resolves({ stdout: 'mysqld is alive\n' })        // docker exec mariadb-admin ping
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('container-root-pass')
                expect(stubs.setDbRootPassword.calledWith('container-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('askMariadbRootPassword()', function () {

        it('persists the container-env password to the credentials store on accept', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).resolves({ stdout: 'container-root-pass\n' })    // docker exec printenv
                .onCall(2).resolves({ stdout: 'mysqld is alive\n' })        // ping
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            try {
                const ds = loadDatabaseService(stubs)
                await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(stubs.saveDbRootPassword.calledWith('container-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('falls back to the credentials-store copy when the container has no MYSQL_ROOT_PASSWORD env', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.loadDbRootPassword.returns('stored-root-pass')
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).rejects(new Error('printenv: MYSQL_ROOT_PASSWORD not set')) // container env missing
                .onCall(2).resolves({ stdout: 'mysqld is alive\n' })        // ping with the stored copy
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('stored-root-pass')
                expect(stubs.setDbRootPassword.calledWith('stored-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('askMariadbRootPassword()', function () {

        it('throws an actionable error instead of prompting when stdin is not a TTY', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.loadDbRootPassword.returns(null)
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).rejects(new Error('printenv: MYSQL_ROOT_PASSWORD not set')) // container env missing
            const savedEnv = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                let err = null
                try { await ds.askMariadbRootPassword('bitcoin', 'mainnet') } catch (e) { err = e }
                expect(err).to.be.an('error')
                expect(err.message).to.include('XCHAIN_NODE_DB_ROOT_PASSWORD')
                expect(err.message).to.include('no TTY')
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
                if (savedEnv === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = savedEnv
            }
        })

        it('ignores a stale credentials-store copy and reaches the prompt on a TTY', async function () {
            let dbRootPassword = null
            const stubs = makeStubs()
            stubs.getDbRootPassword.callsFake(() => dbRootPassword)
            stubs.setDbRootPassword.callsFake(p => { dbRootPassword = p })
            stubs.loadDbRootPassword.returns('stale-stored-pass')
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).rejects(new Error('printenv: MYSQL_ROOT_PASSWORD not set')) // container env missing
                .onCall(2).resolves({ stdout: 'Access denied\n' })          // ping with the stale stored copy: fails
                .onCall(3).resolves({ stdout: 'mysqld is alive\n' })        // ping with the prompted answer
            const savedEnv = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('rootpass')                          // the prompt stub's answer
                expect(stubs.saveDbRootPassword.calledWith('rootpass')).to.be.true
                expect(stubs.setDbRootPassword.calledWith('stale-stored-pass')).to.be.false
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
                if (savedEnv === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = savedEnv
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('askMariadbRootPassword()', function () {

        it('falls back to password prompt when no container found', async function () {
            // When no container exists, prompt runs and setDbRootPassword is called.
            // The while condition checks getDbRootPassword(); after prompt, we need
            // it to return the set value so the loop exits.
            let dbRootPassword = null
            const stubs = makeStubs()
            stubs.getDbRootPassword.callsFake(() => dbRootPassword)
            stubs.setDbRootPassword.callsFake(p => { dbRootPassword = p })
            // getDatabaseContainerId (in checkIfDatabaseModuleExists) rejects -> null container
            stubs.execFileAsync.rejects(new Error('no container'))
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            // The non-TTY guard fails fast before the prompt; force a TTY so
            // this test exercises the prompt path regardless of the runner.
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                // The prompt stub returns 'rootpass' and since no container exists,
                // setDbRootPassword is called directly and 'rootpass' returned
                expect(result).to.equal('rootpass')
                expect(dbRootPassword).to.equal('rootpass')
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})
