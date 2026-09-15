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
