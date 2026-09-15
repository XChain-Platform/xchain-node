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


// clearHubPriceIngestWatermark
//
// A wiped indexer DB restarts push_generations at 0, which the hub's price
// ingest fence reads as a stale replay and drops, taking that chain's price
// rail down. The reset clears the fence row so the rail comes back.

const HUB_CFG = { HUB_DB_NAME: 'XChain_Hub' }


// Fake MariaDB that answers the information_schema probe with `tableCount`
// and records every statement it is handed.
function dockerRunner(stubs, tableCount) {
    const executed = []
    stubs.spawn.callsFake(fakeSpawn((sql) => {
        executed.push(sql)
        if (/information_schema/.test(sql)) return { stdout: String(tableCount) + '\n' }
        return { stdout: '' }
    }))
    return executed
}


// The fence row is keyed (network, source_chain), so the reset's own
// network scopes the DELETE and no other network's fence for the chain can be
// reached by it. This replaced the HUB_NETWORK guard, which had to REFUSE the
// clear whenever a co-located hub named a different network (leaving the reset
// stack's price rail down) and could not refuse at all when HUB_NETWORK was unset.

describe('DatabaseService', function () {

        describe('clearHubPriceIngestWatermark()', function () {

        it('deletes only the reset chain\'s fence row from the hub DB', async function () {
            const stubs = makeStubs()
            const executed = dockerRunner(stubs, 1)
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            expect(await ds.clearHubPriceIngestWatermark('dogecoin', 'mainnet')).to.be.true
            const del = executed.find(s => /^DELETE FROM/.test(s))
            expect(del).to.contain('`XChain_Hub`.price_ingest_watermarks')
            expect(del).to.contain("source_chain = 'DOGE'")
            // Never a blanket wipe: BTC/LTC fences still guard their live ingest.
            expect(del).to.not.match(/TRUNCATE|DELETE FROM `XChain_Hub`\.price_ingest_watermarks\s*$/)
        })

        it('prints the manual statement and returns false when this MariaDB has no hub table', async function () {
            const stubs = makeStubs()
            const executed = dockerRunner(stubs, 0)
            const warn = sinon.stub(console, 'warn')
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            const result = await ds.clearHubPriceIngestWatermark('bitcoin', 'mainnet')
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            warn.restore()
            expect(result).to.be.false
            expect(executed.some(s => /^DELETE FROM/.test(s))).to.be.false
            // The hand-run statement must carry the network clause too: an unscoped paste
            // against a shared hub DB drops every network's fence for the chain.
            expect(lines).to.contain("DELETE FROM price_ingest_watermarks WHERE source_chain = 'BTC' AND network IN ('mainnet', '');")
            expect(lines).to.contain('before the indexer resumes pushing:')
        })

        it('warns instead of throwing when the hub config carries no HUB_DB_NAME', async function () {
            const stubs = makeStubs()
            const executed = dockerRunner(stubs, 1)
            const warn = sinon.stub(console, 'warn')
            const ds = loadDatabaseService(stubs)      // no HUB_DB_NAME in the config
            const result = await ds.clearHubPriceIngestWatermark('litecoin', 'mainnet')
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            warn.restore()
            expect(result).to.be.false
            expect(executed.length).to.equal(0)
            expect(lines).to.contain("source_chain = 'LTC'")
        })
        })
})

describe('DatabaseService', function () {

        describe('clearHubPriceIngestWatermark()', function () {

        it('goes through the native driver in EXTERNAL_DB mode', async function () {
            const stubs = makeStubs()
            const queries = []
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queries.push(sql)
                if (/information_schema/.test(sql)) return Promise.resolve([['1']])
                return Promise.resolve([])
            })
            const savedEnv = {}
            const env = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          '127.0.0.1',
                XCHAIN_NODE_EXTERNAL_DB_PORT:          '3306',
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     'root',
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'test-pass'
            }
            for (const [k, v] of Object.entries(env)) { savedEnv[k] = process.env[k]; process.env[k] = v }
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true }, HUB_CFG)
                expect(await ds.clearHubPriceIngestWatermark('bitcoin', 'mainnet')).to.be.true
                expect(queries.some(q => /^DELETE FROM `XChain_Hub`\.price_ingest_watermarks/.test(q))).to.be.true
                expect(stubs.spawn.called).to.be.false
            } finally {
                for (const [k, v] of Object.entries(savedEnv)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('throws on an unknown coin rather than deleting nothing and reporting success', async function () {
            const stubs = makeStubs()
            dockerRunner(stubs, 1)
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            let threw = null
            try { await ds.clearHubPriceIngestWatermark('notacoin', 'mainnet') } catch (e) { threw = e }
            expect(threw).to.be.an('error')
            expect(threw.message).to.match(/unknown coin/)
        })

        it('refuses a hub DB name that is not a safe identifier', async function () {
            const stubs = makeStubs()
            const executed = dockerRunner(stubs, 1)
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub`; DROP DATABASE x' })
            let threw = null
            try { await ds.clearHubPriceIngestWatermark('bitcoin', 'mainnet') } catch (e) { threw = e }
            expect(threw).to.be.an('error')
            expect(threw.message).to.match(/Unsafe MariaDB database name/)
            expect(executed.length).to.equal(0)
        })
        })
})

describe('DatabaseService', function () {

        describe('clearHubPriceIngestWatermark()', function () {

                describe('a hub database shared with another network', function () {

            it('scopes the delete to the network being reset, leaving every other network\'s fence', async function () {
                const stubs = makeStubs()
                const executed = dockerRunner(stubs, 1)
                // A regtest stack whose co-located hub also serves the live testnet.
                const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub', HUB_NETWORK: 'testnet' })
                expect(await ds.clearHubPriceIngestWatermark('bitcoin', 'regtest')).to.be.true

                const del = executed.find(s => /^DELETE FROM/.test(s))
                expect(del).to.contain("source_chain = 'BTC'")
                // The regtest row goes; the testnet and mainnet rows for BTC are outside
                // the WHERE clause entirely. That is the whole fix.
                expect(del).to.contain("network IN ('regtest', '')")
                expect(del).to.not.contain("'testnet'")
                expect(del).to.not.contain("'mainnet'")
            })


            // Drives the ledger's verify criterion: the same chain, cleared on one network,
            // leaves the other networks' rows addressable and untouched.
            it('issues a different WHERE clause per network for the same chain', async function () {
                const clears = {}
                for (const network of ['regtest', 'testnet', 'mainnet']) {
                    const stubs = makeStubs()
                    const executed = dockerRunner(stubs, 1)
                    const ds = loadDatabaseService(stubs, {}, HUB_CFG)
                    expect(await ds.clearHubPriceIngestWatermark('bitcoin', network)).to.be.true
                    clears[network] = executed.find(s => /^DELETE FROM/.test(s))
                }
                expect(clears.regtest).to.contain("network IN ('regtest', '')")
                expect(clears.testnet).to.contain("network IN ('testnet', '')")
                expect(clears.mainnet).to.contain("network IN ('mainnet', '')")
                expect(clears.regtest).to.not.equal(clears.testnet)
                expect(clears.testnet).to.not.equal(clears.mainnet)
            })


            // The hub folds HUB_NETWORK the same way (db.js normalizeFenceNetwork). If the
            // two sides disagreed on casing the DELETE would match nothing and still report
            // success, which is the silent-no-op shape this asserts against.
            it('folds the reset network case- and whitespace-insensitively, matching the hub', async function () {
                const stubs = makeStubs()
                const executed = dockerRunner(stubs, 1)
                const ds = loadDatabaseService(stubs, {}, HUB_CFG)
                expect(await ds.clearHubPriceIngestWatermark('bitcoin', '  RegTest ')).to.be.true
                const del = executed.find(s => /^DELETE FROM/.test(s))
                expect(del).to.contain("network IN ('regtest', '')")
            })
                })
        })
})

describe('DatabaseService', function () {

        describe('clearHubPriceIngestWatermark()', function () {

                describe('a hub database shared with another network', function () {


            // Pre-migration rows, and rows from a hub with HUB_NETWORK unset, sit in the ''
            // bucket. Clearing them is exactly what shipped before the column existed, so a
            // reset against a not-yet-backfilled hub still brings the price rail back.
            it('clears the legacy unset bucket alongside the network row', async function () {
                const stubs = makeStubs()
                const executed = dockerRunner(stubs, 1)
                const ds = loadDatabaseService(stubs, {}, HUB_CFG)
                expect(await ds.clearHubPriceIngestWatermark('bitcoin', 'testnet')).to.be.true
                const del = executed.find(s => /^DELETE FROM/.test(s))
                expect(del).to.match(/network IN \('testnet', ''\)/)
            })


            // The old guard refused outright. It must not survive: a refusal now leaves the
            // reset stack's own fence standing and its price rail down for no reason.
            it('no longer refuses on a hub configured for another network', async function () {
                const stubs = makeStubs()
                const executed = dockerRunner(stubs, 1)
                const warn = sinon.stub(console, 'warn')
                const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub', HUB_NETWORK: 'mainnet' })
                const result = await ds.clearHubPriceIngestWatermark('litecoin', 'regtest')
                const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
                warn.restore()

                expect(result).to.be.true
                expect(executed.some(s => /^DELETE FROM/.test(s))).to.be.true
                expect(lines).to.not.contain('was NOT cleared')
            })
                })
        })
})
