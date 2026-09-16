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


// -------------------------------------------------------------------
// addUserPasswordToDatabase: SQL-injection / quote-breakage safety
// Provisioning DDL is built by string concatenation (identifiers cannot be
// bound, the docker path pipes raw SQL), so the account password must be
// emitted as a properly escaped literal and identifiers must be allowlisted.
// -------------------------------------------------------------------

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase(): provisioning-SQL safety', function () {

        it('escapes a quote-containing password into a single well-formed string literal (docker path)', async function () {
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            // A password crafted to break out of the IDENTIFIED BY '...' literal
            // and inject a second statement executed as root.
            const evilPass = "x'; DROP DATABASE XChain_BTC_Mainnet_Decoder; --"
            const result = await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', evilPass
            )
            expect(result).to.be.true

            const createUser = executedCommands.find(c => c && c.startsWith('CREATE USER'))
            expect(createUser, 'CREATE USER statement should have run').to.exist
            // The embedded quote is backslash-escaped, so the injected DROP stays
            // inside the string literal and never becomes a separate statement.
            expect(createUser).to.include("IDENTIFIED BY 'x\\'; DROP DATABASE XChain_BTC_Mainnet_Decoder; --'")
            expect(createUser).to.not.match(/IDENTIFIED BY 'x';\s*DROP DATABASE/)
        })

        it('leaves a plain password byte-for-byte unchanged (no behaviour drift for existing installs)', async function () {
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'plain-Pass_09'
            )
            const createUser = executedCommands.find(c => c && c.startsWith('CREATE USER'))
            expect(createUser).to.include("IDENTIFIED BY 'plain-Pass_09'")
        })
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase(): provisioning-SQL safety', function () {

        it('rejects an injection-bearing database name before any SQL runs', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            try {
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    "XChain`; DROP DATABASE x; --", 'xchain_decoder_bitcoin_mainnet', 'test-pass'
                )
                expect.fail('should have thrown on unsafe database name')
            } catch (err) {
                expect(err.message).to.match(/Unsafe MariaDB database name/)
            }
            expect(stubs.spawn.called, 'no docker exec should run for a rejected identifier').to.be.false
        })

        it('rejects an injection-bearing user name before any SQL runs', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            try {
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', "u'@'%'; DROP USER root; --", 'test-pass'
                )
                expect.fail('should have thrown on unsafe user name')
            } catch (err) {
                expect(err.message).to.match(/Unsafe MariaDB database user/)
            }
            expect(stubs.spawn.called, 'no docker exec should run for a rejected identifier').to.be.false
        })
        })
})
