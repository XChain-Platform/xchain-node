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

        describe('addUserPasswordToDatabase()', function () {

        it('creates database and user via docker when db does not exist', async function () {
            const stubs = makeStubs()
            // execFileAsync[0] = docker inspect (getDatabaseContainerId in checkIfDatabaseIsReady)
            // executeDockerMariaDbCommand pipes the SQL via stdin; branch on it.
            // dbCount = '0' → create DB + user + grant
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                // Return '0' for COUNT queries, '' for DDL
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            const result = await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass'
            )
            expect(result).to.be.true
        })

        it('skips create when database already exists (dbCount != 0)', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                if (sql.startsWith('SELECT COUNT(SCHEMA_NAME)')) return { stdout: '1\n' } // DB already exists
                if (sql.startsWith('SELECT COUNT(*)')) return { stdout: '1\n' } // user already exists
                if (sql.startsWith('SHOW GRANTS')) {
                    // Include the full grant so it skips GRANT command too
                    return { stdout: "GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'\n" }
                }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            const result = await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass'
            )
            expect(result).to.be.true
        })
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase()', function () {

        it('grants MVH test permissions when module is xchain-hub', async function () {
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
                'xchain-hub', 'bitcoin', 'mainnet',
                'xchain_node', 'xchain_node_user', 'test-pass'
            )
            const mvhGrant = executedCommands.find(c => c && c.includes('MVH'))
            expect(mvhGrant).to.exist
        })

        it('grants DrillB parity permissions to a NON-mainnet indexer', async function () {
            // Two-node parity drills clone the live indexer DB into a second schema and
            // run a second indexer against it. Without this grant the drill is BTC-only
            // by accident: the BTC account happens to hold ALL PRIVILEGES on Drill
            // schemas left by the flag-day drill, every other chain's account does not,
            // and node B's CREATE DATABASE is simply refused.
            const stubs = makeStubs();
            const executedCommands = [];
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql);
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' };
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' };
                return { stdout: '' };
            }));
            const ds = loadDatabaseService(stubs);
            await ds.addUserPasswordToDatabase(
                'xchain-indexer', 'litecoin', 'regtest',
                'XChain_LTC_Regtest_Indexer', 'xchain_indexer_litecoin_regtest', 'test-pass'
            );
            const grant = executedCommands.find(c => c && c.includes('DrillB'));
            expect(grant, 'a regtest indexer account can create its own parity schema').to.exist;
            // Escaped underscores: the pattern must match DrillB schemas and nothing else.
            expect(grant).to.include('XChain\\_%\\_DrillB\\_%');
        });
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase()', function () {

        it('withholds the DrillB grant from a MAINNET indexer', async function () {
            // Stricter than the MVH grant beside it, deliberately: drills run on drill
            // venues, and a mainnet indexer account has no business holding CREATE/DROP
            // over any name pattern.
            const stubs = makeStubs();
            const executedCommands = [];
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql);
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' };
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' };
                return { stdout: '' };
            }));
            const ds = loadDatabaseService(stubs);
            await ds.addUserPasswordToDatabase(
                'xchain-indexer', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Indexer', 'xchain_indexer_bitcoin_mainnet', 'test-pass'
            );
            expect(executedCommands.find(c => c && c.includes('DrillB')), 'no wildcard grant on mainnet').to.not.exist;
        });

        it('grants SLAVE MONITOR to indexer and decoder accounts, on MAINNET too', async function () {
            // Unlike the DrillB grant above, this one is NOT withheld from mainnet: a
            // silently stalled replica does the most damage there, and the privilege is a
            // read-only view of replication topology rather than data access.
            for (const [module, coin, network, dbName, user] of [
                ['xchain-indexer', 'bitcoin',  'mainnet', 'XChain_BTC_Mainnet_Indexer',  'xchain_indexer_bitcoin_mainnet'],
                ['xchain-decoder', 'litecoin', 'testnet', 'XChain_LTC_Testnet_Decoder',  'xchain_decoder_litecoin_testnet'],
            ]) {
                const stubs = makeStubs();
                const executedCommands = [];
                stubs.spawn.callsFake(fakeSpawn((sql) => {
                    executedCommands.push(sql);
                    if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' };
                    if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' };
                    return { stdout: '' };
                }));
                const ds = loadDatabaseService(stubs);
                await ds.addUserPasswordToDatabase(module, coin, network, dbName, user, 'test-pass');
                const grant = executedCommands.find(c => c && c.includes('SLAVE MONITOR'));
                expect(grant, module + ' on ' + network + ' must be able to read replication status').to.exist;
                expect(grant).to.include('ON *.*');
                expect(grant, 'the grant must name the account being provisioned').to.include(user);
            }
        });
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase()', function () {

        it('withholds SLAVE MONITOR from the hub account', async function () {
            // Scope check with teeth: the grant is for the accounts xchain-sync actually
            // polls. A blanket "every account provisioned here" version of the fix would
            // pass the test above and quietly widen the hub's privileges too.
            const stubs = makeStubs();
            const executedCommands = [];
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql);
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' };
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' };
                return { stdout: '' };
            }));
            const ds = loadDatabaseService(stubs);
            await ds.addUserPasswordToDatabase(
                'xchain-hub', 'bitcoin', 'mainnet',
                'xchain_node', 'xchain_node_user', 'test-pass'
            );
            expect(executedCommands.find(c => c && c.includes('SLAVE MONITOR')), 'hub does not poll replicas').to.not.exist;
        });

        it('rotates the password via ALTER USER on the docker path when the user does not match', async function () {
            // userCount == 0 covers both "user absent" and "user exists with a different
            // password". The docker path must ALTER USER (not just CREATE USER IF NOT EXISTS,
            // a no-op for an existing user) so an existing install is migrated off the legacy
            // static password to the generated per-install one on the next update.
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT(SCHEMA_NAME)')) return { stdout: '1\n' } // DB already exists
                if (sql.startsWith('SELECT COUNT(*)')) return { stdout: '0\n' }            // user missing OR password mismatch
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'rotated-pass'
            )
            const alter = executedCommands.find(c => c && /^ALTER USER .* IDENTIFIED BY 'rotated-pass'/.test(c))
            expect(alter, 'docker path must ALTER USER to force the new password').to.exist
        })
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase()', function () {

        it('throws when docker exec fails', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ error: new Error('docker exec failed') })))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass'
                )
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('docker exec failed')
            }
        })
        })
})
