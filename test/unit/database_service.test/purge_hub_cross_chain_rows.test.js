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


// A hub database outlives the chain it federates: its cross-chain rows are
// keyed by `network` and a BTC-anchored snapshot_block, so on regtest one
// network value spans every chain the venue has ever had and a fresh indexer
// mirrors the dead chain's finalized matches back in. The chain reset is
// what removes them.

const HUB_CFG = { HUB_DB_NAME: 'XChain_Hub' }


// Fake MariaDB: `tables` answers the information_schema presence probe,
// `foreignRows` the "does this hub also hold another network" count.
function purgeRunner(stubs, { tables = 3, foreignRows = 0 } = {}) {
    const executed = []
    stubs.spawn.callsFake(fakeSpawn((sql) => {
        executed.push(sql)
        if (/information_schema/.test(sql)) return { stdout: String(tables) + '\n' }
        if (/^SELECT COUNT/.test(sql)) return { stdout: String(foreignRows) + '\n' }
        return { stdout: '' }
    }))
    return executed
}

function deletesIn(executed) {
    return executed.filter(s => /^DELETE FROM/.test(s))
}

describe('DatabaseService', function () {

        describe('purgeHubCrossChainRows()', function () {

        it('purges all three tables for a Bitcoin regtest re-genesis', async function () {
            const stubs = makeStubs()
            const executed = purgeRunner(stubs)
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            const log = sinon.stub(console, 'log')
            let result
            try { result = await ds.purgeHubCrossChainRows('bitcoin', 'regtest') } finally { log.restore() }
            const lines = log.getCalls().map(c => String(c.args[0])).join('\n')
            expect(result).to.be.true
            const deletes = deletesIn(executed)
            expect(deletes).to.have.lengthOf(3)
            expect(deletes[0]).to.contain('`XChain_Hub`.cross_chain_matches')
            expect(deletes[0]).to.contain("network = 'regtest'")
            expect(deletes[1]).to.contain('`XChain_Hub`.cross_chain_calls')
            expect(deletes[1]).to.contain("network = 'regtest'")
            // Bitcoin is the anchor chain, so the whole validator-set table dies
            // with it; it carries no network column to scope on.
            expect(deletes[2].trim()).to.match(/^DELETE FROM `XChain_Hub`\.capability_snapshots;?$/)
            // The engine only rebuilds its committed ledger at startup.
            expect(lines).to.contain('xchain-node restart xchain-hub')
        })

        it('purges only the leg-scoped rows for a non-Bitcoin regtest re-genesis', async function () {
            const stubs = makeStubs()
            const executed = purgeRunner(stubs, { tables: 2 })
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            const log = sinon.stub(console, 'log')
            let result
            try { result = await ds.purgeHubCrossChainRows('dogecoin', 'regtest') } finally { log.restore() }
            expect(result).to.be.true
            const deletes = deletesIn(executed)
            expect(deletes).to.have.lengthOf(2)
            expect(deletes[0]).to.contain("a_chain = 'DOGE' OR b_chain = 'DOGE'")
            expect(deletes[1]).to.contain("source_chain = 'DOGE' OR target_chain = 'DOGE'")
            // Snapshots are anchored on Bitcoin blocks that did not move, and a
            // match between two OTHER chains is still valid.
            expect(executed.some(s => /capability_snapshots/.test(s))).to.be.false
            expect(deletes.every(s => /network = 'regtest'/.test(s))).to.be.true
        })

        it('touches nothing at all off regtest', async function () {
            for (const network of ['mainnet', 'testnet']) {
                const stubs = makeStubs()
                const executed = purgeRunner(stubs)
                const ds = loadDatabaseService(stubs, {}, HUB_CFG)
                expect(await ds.purgeHubCrossChainRows('bitcoin', network),
                    `expected false on ${network}`).to.be.false
                expect(executed.length, `expected no SQL on ${network}`).to.equal(0)
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('purgeHubCrossChainRows()', function () {

        it('prints the manual statements and returns false when this MariaDB has no hub tables', async function () {
            const stubs = makeStubs()
            const executed = purgeRunner(stubs, { tables: 0 })
            const warn = sinon.stub(console, 'warn')
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            const result = await ds.purgeHubCrossChainRows('bitcoin', 'regtest')
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            warn.restore()
            expect(result).to.be.false
            expect(deletesIn(executed)).to.have.lengthOf(0)
            expect(lines).to.contain("DELETE FROM cross_chain_matches WHERE network = 'regtest';")
            expect(lines).to.contain("DELETE FROM capability_snapshots;")
        })


        // capability_snapshots has no network column, so the only protection for
        // a hub database that is NOT this regtest stack's is to notice it first.
        it('keeps the snapshots when the hub database holds another network\'s rows', async function () {
            const stubs = makeStubs()
            const executed = purgeRunner(stubs, { tables: 3, foreignRows: 4 })
            const warn = sinon.stub(console, 'warn')
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            const log = sinon.stub(console, 'log')
            let result
            try { result = await ds.purgeHubCrossChainRows('bitcoin', 'regtest') } finally { log.restore(); warn.restore() }
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            expect(result).to.be.true
            const deletes = deletesIn(executed)
            expect(deletes).to.have.lengthOf(2)
            expect(deletes.some(s => /capability_snapshots/.test(s))).to.be.false
            expect(lines).to.contain('rows for another network')
        })

        it('keeps the snapshots when the co-located hub is configured for another network', async function () {
            const stubs = makeStubs()
            const executed = purgeRunner(stubs, { tables: 3, foreignRows: 0 })
            const warn = sinon.stub(console, 'warn')
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub', HUB_NETWORK: 'mainnet' })
            const log = sinon.stub(console, 'log')
            let result
            try { result = await ds.purgeHubCrossChainRows('bitcoin', 'regtest') } finally { log.restore(); warn.restore() }
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            expect(result).to.be.true
            expect(deletesIn(executed).some(s => /capability_snapshots/.test(s))).to.be.false
            expect(lines).to.contain('configured for mainnet')
        })
        })
})

describe('DatabaseService', function () {

        describe('purgeHubCrossChainRows()', function () {

        it('goes through the native driver in EXTERNAL_DB mode', async function () {
            const stubs = makeStubs()
            const queries = []
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queries.push(sql)
                if (/information_schema/.test(sql)) return Promise.resolve([['3']])
                if (/^SELECT COUNT/.test(sql)) return Promise.resolve([['0']])
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
            const log = sinon.stub(console, 'log')
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true }, HUB_CFG)
                expect(await ds.purgeHubCrossChainRows('bitcoin', 'regtest')).to.be.true
                expect(queries.filter(q => /^DELETE FROM `XChain_Hub`\./.test(q))).to.have.lengthOf(3)
                expect(stubs.spawn.called).to.be.false
            } finally {
                log.restore()
                for (const [k, v] of Object.entries(savedEnv)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('throws on an unknown coin rather than purging nothing and reporting success', async function () {
            const stubs = makeStubs()
            purgeRunner(stubs)
            const ds = loadDatabaseService(stubs, {}, HUB_CFG)
            let threw = null
            try { await ds.purgeHubCrossChainRows('notacoin', 'regtest') } catch (e) { threw = e }
            expect(threw).to.be.an('error')
            expect(threw.message).to.match(/unknown coin/)
        })

        it('refuses a hub DB name that is not a safe identifier', async function () {
            const stubs = makeStubs()
            const executed = purgeRunner(stubs)
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: 'XChain_Hub`; DROP DATABASE x' })
            let threw = null
            try { await ds.purgeHubCrossChainRows('bitcoin', 'regtest') } catch (e) { threw = e }
            expect(threw).to.be.an('error')
            expect(threw.message).to.match(/Unsafe MariaDB database name/)
            expect(executed.length).to.equal(0)
        })
        })
})
