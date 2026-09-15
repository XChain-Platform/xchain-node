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


// The rail's hub runs a schema older than the (network, source_chain) re-key,
// so the network-scoped clear the reset issues is rejected outright with
// ER_BAD_FIELD_ERROR and the rebuilt indexer's price rail stays dead. On THAT
// schema the fence is keyed by chain alone, so the chain-only DELETE is the
// statement the table supports and reaches exactly the one row fencing the
// chain.

const HUB_CFG = { HUB_DB_NAME: 'XChain_Hub' }


// MariaDB's real answer when the `network` column is absent, as the client
// prints it on stderr with a non-zero exit.
const UNKNOWN_NETWORK_COLUMN = "ERROR 1054 (42S22) at line 1: Unknown column 'network' in 'where clause'"


// Fake MariaDB that answers the information_schema probe with 1 (the table is
// here) and hands `failure` back for any statement `failOn` matches.
function dockerRunner(stubs, failOn, failure) {
    const executed = []
    stubs.spawn.callsFake(fakeSpawn((sql) => {
        executed.push(sql)
        if (/information_schema/.test(sql)) return { stdout: '1\n' }
        if (failOn && failOn.test(sql)) return { code: 1, stderr: failure }
        return { stdout: '' }
    }))
    return executed
}

function runAndCapture(ds, coin, network) {
    const warn = sinon.stub(console, 'warn')
    const log  = sinon.stub(console, 'log')
    return ds.clearHubPriceIngestWatermark(coin, network)
        .then(result => ({ result, threw: null, warn: lines(warn), log: lines(log) }),
              err     => ({ result: null, threw: err, warn: lines(warn), log: lines(log) }))
        .finally(() => { warn.restore(); log.restore() })
}

function lines(stub) {
    return stub.getCalls().map(c => String(c.args[0]))
}

describe('DatabaseService: clearHubPriceIngestWatermark() against a pre-network-column hub', function () {

    it('falls back to the chain-only delete and reports success', async function () {
        const stubs = makeStubs()
        const executed = dockerRunner(stubs, /network IN/, UNKNOWN_NETWORK_COLUMN)
        const ds = loadDatabaseService(stubs, {}, HUB_CFG)
        const run = await runAndCapture(ds, 'bitcoin', 'regtest')

        expect(run.threw).to.equal(null)
        expect(run.result).to.be.true

        const deletes = executed.filter(s => /^DELETE FROM/.test(s))
        // The scoped clause is still tried first: the fallback is the exception,
        // never the default shape.
        expect(deletes[0]).to.contain("network IN ('regtest', '')")
        // And the retry drops the clause the hub cannot parse, nothing else.
        expect(deletes[1]).to.contain("source_chain = 'BTC'")
        expect(deletes[1]).to.not.contain('network')
        expect(deletes).to.have.length(2)
    })

    it('warns once, naming the column and the hub version that carries it', async function () {
        const stubs = makeStubs()
        dockerRunner(stubs, /network IN/, UNKNOWN_NETWORK_COLUMN)
        const ds = loadDatabaseService(stubs, {}, HUB_CFG)
        const run = await runAndCapture(ds, 'dogecoin', 'regtest')

        const headline = run.warn.filter(l => l.includes('has no `network` column'))
        expect(headline).to.have.length(1)
        expect(run.warn.join('\n')).to.contain('xchain-hub v0.18.0')
        expect(run.warn.join('\n')).to.contain("DELETE FROM price_ingest_watermarks WHERE source_chain = 'DOGE'")
        // The success line must not keep claiming a scope the fallback gave up.
        expect(run.log.join('\n')).to.not.contain("Every other network's fence")
    })


    // The fallback widens the delete from one network to all of them, so it may
    // answer ONLY the missing `network` column. Any other bad-field failure is a
    // different fault, and on a hub that DOES scope by network the same fallback
    // would drop the live networks' fences.
    it('does not fall back for an unknown column that is not `network`', async function () {
        const stubs = makeStubs()
        const executed = dockerRunner(stubs, /network IN/,
            "ERROR 1054 (42S22) at line 1: Unknown column 'source_chain' in 'where clause'")
        const ds = loadDatabaseService(stubs, {}, HUB_CFG)
        const run = await runAndCapture(ds, 'bitcoin', 'mainnet')

        expect(run.threw).to.be.an('error')
        expect(executed.filter(s => /^DELETE FROM/.test(s))).to.have.length(1)
    })
})

describe('DatabaseService: clearHubPriceIngestWatermark() against a pre-network-column hub', function () {

    it('does not fall back on an ordinary SQL failure', async function () {
        const stubs = makeStubs()
        const executed = dockerRunner(stubs, /network IN/,
            "ERROR 1146 (42S02) at line 1: Table 'XChain_Hub.price_ingest_watermarks' doesn't exist")
        const ds = loadDatabaseService(stubs, {}, HUB_CFG)
        const run = await runAndCapture(ds, 'bitcoin', 'mainnet')

        expect(run.threw).to.be.an('error')
        expect(executed.filter(s => /^DELETE FROM/.test(s))).to.have.length(1)
        expect(run.warn.join('\n')).to.not.contain('has no `network` column')
    })


    // EXTERNAL_DB goes through the mariadb driver, which reports the same
    // condition as err.code rather than as client stderr under a numeric exit.
    it('recognises the driver-shaped ER_BAD_FIELD_ERROR in EXTERNAL_DB mode', async function () {
        const stubs = makeStubs()
        const queries = []
        stubs.mariadb._fakeConn.query.callsFake((sql) => {
            queries.push(sql)
            if (/information_schema/.test(sql)) return Promise.resolve([['1']])
            if (/network IN/.test(sql)) {
                const err = new Error("Unknown column 'network' in 'where clause'")
                err.code  = 'ER_BAD_FIELD_ERROR'
                err.errno = 1054
                return Promise.reject(err)
            }
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
            const run = await runAndCapture(ds, 'litecoin', 'testnet')
            expect(run.threw).to.equal(null)
            expect(run.result).to.be.true
            const deletes = queries.filter(q => /^DELETE FROM/.test(q))
            expect(deletes).to.have.length(2)
            expect(deletes[1]).to.not.contain('network')
            expect(run.warn.join('\n')).to.contain('xchain-hub v0.18.0')
        } finally {
            for (const [k, v] of Object.entries(savedEnv)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }
    })
})
