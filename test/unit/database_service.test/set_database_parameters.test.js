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

        describe('setDatabaseParameters()', function () {

        it('iterates installed coins+networks and adds DB users', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                if (sql.startsWith('SELECT COUNT')) return { stdout: '1\n' } // already exists
                if (sql.startsWith('SHOW GRANTS')) {
                    return { stdout: "GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'\nGRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Indexer'.* TO 'xchain_indexer_bitcoin_mainnet'@'%'\n" }
                }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            const result = await ds.setDatabaseParameters()
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.called).to.be.true
        })

        it('throws and logs when coin network processing fails', async function () {
            const stubs = makeStubs()
            stubs.addContainerToNetwork.rejects(new Error('network error'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('network error')
            }
        })


        // This is the ONLY step that writes the freshly-minted decoder /
        // indexer password into MariaDB, and both callers run it right after a
        // buildAndUp. An empty iteration can return true, bypassing the caller's
        // throw-on-error guard and reporting a successful install while the new
        // container crash-loops on ER_ACCESS_DENIED.
        it('refuses to run against an unconfigured module registry', async function () {
            const stubs = makeStubs()
            stubs.db.assertReady.throws(new Error('MariaDbStore is not connected'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.match(/not connected/)
            }
            expect(stubs.addContainerToNetwork.called).to.be.false
        })
        })
})

describe('DatabaseService', function () {

        describe('setDatabaseParameters()', function () {

        it('throws instead of reporting success when no coin/network is installed', async function () {
            const stubs = makeStubs()
            stubs.getInstalledCoinsAndNetworks.resolves({})
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('an empty iteration must not read as success')
            } catch (err) {
                expect(err.message).to.match(/no installed coin\/network/)
            }
        })

        it('throws when the registry lists a coin but holds no decoder/indexer container', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('provisioning zero accounts must not read as success')
            } catch (err) {
                expect(err.message).to.match(/provisioned no MariaDB account/)
                expect(err.message).to.match(/bitcoin/)
            }
        })


        // Two installs sharing one Docker daemon and one MariaDB pin
        // different passwords for the same account, and whichever provisions last
        // locks the other's container out for as long as nobody notices.
        it('checks for credential drift with the config values, before any account write', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                if (sql.startsWith('SELECT COUNT')) return { stdout: '1\n' }
                if (sql.startsWith('SHOW GRANTS')) {
                    return { stdout: "GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'\nGRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Indexer'.* TO 'xchain_indexer_bitcoin_mainnet'@'%'\n" }
                }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.setDatabaseParameters()
            expect(stubs.assertNoDbCredentialDrift.calledOnce).to.be.true
            const [coin, network, intended] = stubs.assertNoDbCredentialDrift.firstCall.args
            expect(coin).to.equal('bitcoin')
            expect(network).to.equal('mainnet')
            expect(intended).to.deep.equal({ decoder: 'test-pass', indexer: 'test-pass' })
            // The guard has to land before the first ALTER USER, or a refusal
            // arrives after the lockout it exists to prevent.
            expect(stubs.assertNoDbCredentialDrift.calledBefore(stubs.spawn)).to.be.true
        })
        })
})

describe('DatabaseService', function () {

        describe('setDatabaseParameters()', function () {

        it('writes no account when the drift guard refuses', async function () {
            const driftError = new Error('would be locked out')
            driftError.code = 'DB_CREDENTIAL_DRIFT'
            const stubs = makeStubs()
            stubs.assertNoDbCredentialDrift.rejects(driftError)
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('a drift refusal must abort provisioning')
            } catch (err) {
                expect(err.code).to.equal('DB_CREDENTIAL_DRIFT')
            }
            expect(stubs.spawn.called).to.be.false
        })

        it('does not blame the docker network for a drift refusal', async function () {
            const driftError = new Error('would be locked out')
            driftError.code = 'DB_CREDENTIAL_DRIFT'
            const stubs = makeStubs()
            stubs.assertNoDbCredentialDrift.rejects(driftError)
            const log = sinon.stub(console, 'log')
            try {
                const ds = loadDatabaseService(stubs)
                await ds.setDatabaseParameters().then(
                    () => expect.fail('should have thrown'),
                    () => {}
                )
                const printed = log.getCalls().map(c => String(c.args[0])).join('\n')
                expect(printed).to.not.match(/problem adding the database container to the docker network/)
            } finally {
                log.restore()
            }
        })
        })
})
