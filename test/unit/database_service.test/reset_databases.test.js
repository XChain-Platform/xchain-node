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

        describe('resetDatabases()', function () {

        it('drops and recreates each database module', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.resetDatabases('bitcoin', 'mainnet')
            // Should have executed DROP + CREATE for decoder and indexer
            const dropCmds = executed.filter(c => c && c.includes('DROP DATABASE'))
            expect(dropCmds.length).to.be.greaterThan(0)
        })


        // The guard lives inside resetDatabases, not only in resetModules: the
        // function is exported, and a DROP aimed at a null container id aborts
        // part-way through a wipe. Assert it refuses BEFORE issuing anything.
        it('refuses to drop anything when no MariaDB container exists', async function () {
            const stubs = makeStubs({
                // No container: `docker inspect` finds nothing, so
                // getDatabaseContainerId() returns null.
                execFileAsync: sinon.stub().rejects(new Error('No such container'))
            })
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            let err = null
            try {
                await ds.resetDatabases('bitcoin', 'mainnet')
            } catch (e) {
                err = e
            }
            expect(err).to.not.equal(null)
            expect(String(err.message)).to.contain('MariaDB container not found')
            expect(executed.filter(c => c && c.includes('DROP DATABASE'))).to.have.length(0)
        })
        })
})

describe('DatabaseService', function () {

        describe('resetDatabases()', function () {


        // A database name reaches SQL as text, so this destructive site gates it
        // on the same allowlist every sibling DDL site applies (uuid:0257cadf).
        // The whole set is asserted before the first DROP, so a bad name on the
        // SECOND module cannot fire with the first database already gone.
        it('refuses the docker-mode reset when a derived database name is not a safe identifier', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            // Empty configured names so the DERIVED name is the one under test;
            // the configured name has its own case below.
            const ds = loadDatabaseService(stubs, {}, { DECODER_DB_NAME: '', INDEXER_DB_NAME: '' }, {
                getModuleDatabaseName: () => 'XChain_BTC_Mainnet_Decoder; DROP DATABASE mysql'
            })
            let err = null
            try {
                await ds.resetDatabases('bitcoin', 'mainnet')
            } catch (e) { err = e }
            expect(err).to.not.equal(null)
            expect(String(err.message)).to.contain('Unsafe MariaDB database name')
            expect(executed.filter(c => c && c.includes('DROP DATABASE'))).to.have.length(0)
        })

        it('refuses the external-DB reset on the second module before the first is dropped', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const queried = []
            stubs.mariadb.createConnection = sinon.stub().resolves({
                query: async (sql) => { queried.push(sql); return [] },
                end: async () => {}
            })
            let call = 0
            const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true }, { DECODER_DB_NAME: '', INDEXER_DB_NAME: '' }, {
                // First module resolves clean, second does not: the pre-loop
                // assertion is what keeps the first DROP from having run.
                getModuleDatabaseName: () => (++call === 1 ? 'XChain_BTC_Mainnet_Decoder' : 'bad-name')
            })
            let err = null
            try {
                await ds.resetDatabases('bitcoin', 'mainnet')
            } catch (e) { err = e }
            expect(err).to.not.equal(null)
            expect(String(err.message)).to.contain('Unsafe MariaDB database name')
            expect(queried.filter(q => String(q).includes('DROP DATABASE'))).to.have.length(0)
            expect(executed.filter(c => c && c.includes('DROP DATABASE'))).to.have.length(0)
        })
        })
})

describe('DatabaseService', function () {

        describe('resetDatabases()', function () {


        // Provisioning grants on cfg["*_DB_NAME"], which the operator can override in
        // the coin-network config file. A reset that dropped the DERIVED default name
        // instead left the live database intact and wiped whatever else on that server
        // owned the default name (uuid:fd543c4a).
        it('drops the CONFIGURED database names, not the derived defaults', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs, {},
                { DECODER_DB_NAME: 'CustomDecoder', INDEXER_DB_NAME: 'CustomIndexer' },
                { getModuleDatabaseName: () => 'XChain_BTC_Mainnet_Derived' })
            await ds.resetDatabases('bitcoin', 'mainnet')
            const drops = executed.filter(c => c && c.includes('DROP DATABASE')).join(' | ')
            expect(drops).to.contain('CustomDecoder')
            expect(drops).to.contain('CustomIndexer')
            expect(drops).to.not.contain('XChain_BTC_Mainnet_Derived')
        })


        // The configured name is the one an operator types, so it is the untrusted
        // one; the allowlist must cover it and still fire before the first DROP.
        it('refuses the reset when a CONFIGURED database name is not a safe identifier', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs, {},
                { DECODER_DB_NAME: 'XChain_BTC_Mainnet_Decoder', INDEXER_DB_NAME: 'Custom; DROP DATABASE mysql' },
                { getModuleDatabaseName: () => 'XChain_BTC_Mainnet_Decoder' })
            let err = null
            try {
                await ds.resetDatabases('bitcoin', 'mainnet')
            } catch (e) { err = e }
            expect(err).to.not.equal(null)
            expect(String(err.message)).to.contain('Unsafe MariaDB database name')
            expect(executed.filter(c => c && c.includes('DROP DATABASE'))).to.have.length(0)
        })
        })
})

describe('DatabaseService', function () {

        describe('resetDatabases()', function () {


        // A config that carries no name at all (an older install, or a module outside
        // the two DB modules) still resets the derived default rather than nothing.
        it('falls back to the derived name when config carries no database name', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs, {}, { DECODER_DB_NAME: '', INDEXER_DB_NAME: '' },
                { getModuleDatabaseName: () => 'XChain_BTC_Mainnet_Derived' })
            await ds.resetDatabases('bitcoin', 'mainnet')
            const drops = executed.filter(c => c && c.includes('DROP DATABASE')).join(' | ')
            expect(drops).to.contain('XChain_BTC_Mainnet_Derived')
        })
        })
})

describe('DatabaseService', function () {

    // A `reset --db-container` hands both DB steps the server it resolved. They must run there with that server's
    // root, and must not ask for the bundled container or the CLI's cached root at all.
    describe('resetDatabases() and clearHubPriceIngestWatermark() on a named server', function () {
        const NAMED = { containerName: 'xchain-rail-database', containerId: 'c'.repeat(64), rootPassword: 'named-root' }

        // Every mariadb child the source spawns, as the SQL it piped, its argv and its env.
        function recordSpawns(stubs, respond) {
            const calls = []
            stubs.spawn.callsFake(fakeSpawn((sql, args, opts) => {
                calls.push({ sql, args, env: (opts && opts.env) || {} })
                return respond(sql)
            }))
            return calls
        }

        it('drops and recreates each database on the named container with its root', async function () {
            const stubs = makeStubs()
            const calls = recordSpawns(stubs, () => ({ stdout: '' }))
            const ds = loadDatabaseService(stubs)
            await ds.resetDatabases('bitcoin', 'mainnet', ['xchain-decoder', 'xchain-indexer'], NAMED)

            expect(calls.map(c => c.sql).join(' | ')).to.contain('DROP DATABASE IF EXISTS XChain_BTC_Mainnet_Decoder')
                .and.to.contain('DROP DATABASE IF EXISTS XChain_BTC_Mainnet_Indexer')
            for (const call of calls) {
                expect(call.args).to.include(NAMED.containerId)
                expect(call.env.MYSQL_PWD).to.equal('named-root')
            }
            expect(stubs.getDbRootPassword.called).to.be.false
            expect(stubs.execFileAsync.called).to.be.false
        })

        it('clears the price fence row on the named container', async function () {
            const stubs = makeStubs()
            const calls = recordSpawns(stubs, (sql) => ({ stdout: /information_schema/i.test(sql) ? '1' : '' }))
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub' })
            expect(await ds.clearHubPriceIngestWatermark('bitcoin', 'regtest', NAMED)).to.be.true

            expect(calls.map(c => c.sql).join(' | ')).to.match(/DELETE\s+FROM\s+`?XChain_Hub`?\.`?price_ingest_watermarks/i)
            for (const call of calls) {
                expect(call.args).to.include(NAMED.containerId)
                expect(call.env.MYSQL_PWD).to.equal('named-root')
            }
            expect(stubs.getDbRootPassword.called).to.be.false
            expect(stubs.execFileAsync.called).to.be.false
        })
    })
})

describe('DatabaseService', function () {

    // With no root for the named server, each database is dropped and recreated by the user that owns it, and the
    // fence clear runs as the hub's user: the users resolveNamedDatabaseTarget checked before anything was stopped.
    describe('resetDatabases() and clearHubPriceIngestWatermark() as the stack\'s own users', function () {
        const login = (user, password) => ({ user, password, prefix: 'X', grants: [] })
        const SERVICE = {
            containerName: 'xchain-rail-database', containerId: 'c'.repeat(64), authMode: 'service',
            logins: { XChain_BTC_Mainnet_Decoder: login('dec_user', 'dec-pw'), XChain_BTC_Mainnet_Indexer: login('idx_user', 'idx-pw') },
            hubLogin: login('hub_user', 'hub-pw')
        }

        function recordSpawns(stubs, respond) {
            const calls = []
            stubs.spawn.callsFake(fakeSpawn((sql, args, opts) => {
                calls.push({ sql, user: args[args.indexOf('-u') + 1], password: opts.env.MYSQL_PWD })
                return respond(sql)
            }))
            return calls
        }

        it('drops and recreates each database as its own user', async function () {
            const stubs = makeStubs()
            const calls = recordSpawns(stubs, () => ({ stdout: '' }))
            const ds = loadDatabaseService(stubs)
            await ds.resetDatabases('bitcoin', 'mainnet', ['xchain-decoder', 'xchain-indexer'], SERVICE)

            expect(calls.map(({ sql, user, password }) => [sql.match(/DROP DATABASE IF EXISTS (\w+)/)[1], user, password])).to.deep.equal([
                ['XChain_BTC_Mainnet_Decoder', 'dec_user', 'dec-pw'],
                ['XChain_BTC_Mainnet_Indexer', 'idx_user', 'idx-pw']
            ])
            expect(stubs.getDbRootPassword.called).to.be.false
        })

        it('clears the price fence as the hub user', async function () {
            const stubs = makeStubs()
            const calls = recordSpawns(stubs, (sql) => ({ stdout: /information_schema/i.test(sql) ? '1' : '' }))
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub' })
            expect(await ds.clearHubPriceIngestWatermark('bitcoin', 'regtest', SERVICE)).to.be.true

            expect(calls.some((c) => /DELETE\s+FROM\s+`XChain_Hub`\.price_ingest_watermarks/.test(c.sql))).to.be.true
            for (const call of calls) expect([call.user, call.password]).to.deep.equal(['hub_user', 'hub-pw'])
        })

        it('runs nothing and throws when no hub login was resolved', async function () {
            const stubs = makeStubs()
            const calls = recordSpawns(stubs, () => ({ stdout: '1' }))
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub' })
            let err = null
            try { await ds.clearHubPriceIngestWatermark('bitcoin', 'regtest', { ...SERVICE, hubLogin: null }) } catch (e) { err = e }

            expect(err && err.message).to.contain('no hub login was resolved on xchain-rail-database')
            expect(calls).to.have.length(0)
        })
    })
})
