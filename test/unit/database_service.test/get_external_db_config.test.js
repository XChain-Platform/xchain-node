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

let savedEnv = {}

const ENV_KEYS = [
    'XCHAIN_NODE_EXTERNAL_DB_HOST',
    'XCHAIN_NODE_EXTERNAL_DB_PORT',
    'XCHAIN_NODE_EXTERNAL_DB_ROOT_USER',
    'XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD'
]

describe('DatabaseService', function () {

        describe('getExternalDbConfig()', function () {

        beforeEach(function () {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k]
                delete process.env[k]
            }
        })

        afterEach(function () {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k]
                else process.env[k] = savedEnv[k]
            }
        })

        it('returns config from env vars when all four are set', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3307'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'admin'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'

            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.getExternalDbConfig()

            expect(result.host).to.equal('db.example.com')
            expect(result.port).to.equal(3307)
            expect(result.root_user).to.equal('admin')
            expect(result.root_password).to.equal('test-pass')
        })

        it('returns saved config from credentials when ping succeeds', async function () {
            const savedCfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' }
            const stubs = makeStubs({
                hasExternalDbConfig: sinon.stub().returns(true),
                loadExternalDbConfig: sinon.stub().returns(savedCfg)
            })
            // mariadb ping should succeed
            stubs.mariadb._fakeConn.query.resolves([])
            const ds = loadDatabaseService(stubs)
            const result = await ds.getExternalDbConfig()
            expect(result).to.deep.equal(savedCfg)
        })
        })
})

describe('DatabaseService', function () {

        describe('getExternalDbConfig()', function () {

        beforeEach(function () {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k]
                delete process.env[k]
            }
        })

        afterEach(function () {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k]
                else process.env[k] = savedEnv[k]
            }
        })

        it('re-prompts interactively when saved config ping fails', async function () {
            const savedCfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'old-pass' }
            const stubs = makeStubs({
                hasExternalDbConfig: sinon.stub().returns(true),
                loadExternalDbConfig: sinon.stub().returns(savedCfg)
            })
            // First ping (saved config) fails; second ping (from prompt) succeeds
            stubs.mariadb.createConnection
                .onFirstCall().rejects(new Error('auth failed'))
                .resolves(stubs.mariadb._fakeConn)

            // The prompt path is TTY-gated, and a mocha run has no TTY on stdin
            // under CI. Assert the interactive behaviour on an interactive stdin.
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.getExternalDbConfig()
                expect(stubs.saveExternalDbConfig.calledOnce).to.be.true
                expect(result).to.be.an('object')
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('getExternalDbConfig()', function () {

        beforeEach(function () {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k]
                delete process.env[k]
            }
        })

        afterEach(function () {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k]
                else process.env[k] = savedEnv[k]
            }
        })


        // The prompt loop is reached from preCheck/ensureDatabasePool inside the CLI
        // command lock, so hanging on stdin wedges every later command on the host.
        it('fails fast instead of prompting when stdin is not a TTY', async function () {
            const stubs = makeStubs()
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                let threw = null
                try { await ds.getExternalDbConfig() } catch (e) { threw = e }
                expect(threw, 'expected a fail-fast error with no TTY').to.be.an('error')
                expect(threw.message).to.match(/no TTY to prompt on/)
                expect(threw.message).to.include('XCHAIN_NODE_EXTERNAL_DB_HOST')
                expect(threw.message).to.include('XCHAIN_NODE_EXTERNAL_DB_PORT')
                expect(threw.message).to.include('XCHAIN_NODE_EXTERNAL_DB_ROOT_USER')
                expect(threw.message).to.include('XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD')
                expect(stubs.saveExternalDbConfig.called).to.be.false
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('getExternalDbConfig()', function () {

        beforeEach(function () {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k]
                delete process.env[k]
            }
        })

        afterEach(function () {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k]
                else process.env[k] = savedEnv[k]
            }
        })


        // A partial env set must NOT be treated as the headless fast path: it would
        // silently fall back to 127.0.0.1:3306 defaults if the guard were relaxed.
        it('fails fast on a partial env set rather than prompting headlessly', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST      = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT      = '3307'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER = 'admin'
            // XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD deliberately absent

            const stubs = makeStubs()
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                let threw = null
                try { await ds.getExternalDbConfig() } catch (e) { threw = e }
                expect(threw, 'expected a fail-fast error for a partial env set').to.be.an('error')
                expect(threw.message).to.match(/no TTY to prompt on/)
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
            }
        })


        // #3143: the external-DB port must be validatePort-gated at the resolver,
        // so a malformed env value fails loud here rather than propagating NaN
        // into spawn('mariadb', '-P', ...) and every container's *_DB_PORT env.
        it('throws on a malformed external-DB port from env instead of returning NaN', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = 'not-a-port'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'admin'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'

            const ds = loadDatabaseService(makeStubs())
            let threw = null
            try { await ds.getExternalDbConfig() } catch (e) { threw = e }
            expect(threw, 'expected a thrown error for a bad port').to.be.an('error')
            expect(threw.message).to.match(/Invalid external-DB port/)
        })
        })
})

describe('DatabaseService', function () {

        describe('getExternalDbConfig()', function () {

        beforeEach(function () {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k]
                delete process.env[k]
            }
        })

        afterEach(function () {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k]
                else process.env[k] = savedEnv[k]
            }
        })

        it('throws on an out-of-range external-DB port from env', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '70000'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'admin'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'

            const ds = loadDatabaseService(makeStubs())
            let threw = null
            try { await ds.getExternalDbConfig() } catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an out-of-range port').to.be.an('error')
            expect(threw.message).to.match(/Invalid external-DB port/)
        })
        })
})
