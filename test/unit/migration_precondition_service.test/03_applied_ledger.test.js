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

function registerReadableLedgerTests({ expect, readAppliedMigrations, GATED }, target, runnerFor) {
    it('reads the ledger into a set of applied names', async () => {
        const res = await readAppliedMigrations(target, { runner: runnerFor({ names: [GATED, '2026-08-11-attests-relay-identity-index.sql'] }) })
        expect(res.state).to.equal('ledger')
        expect([...res.applied]).to.have.members([GATED, '2026-08-11-attests-relay-identity-index.sql'])
    })

    it('tolerates a ledger read that comes back empty', async () => {
        const res = await readAppliedMigrations(target, { runner: runnerFor({ names: [] }) })
        expect(res.state).to.equal('ledger')
        expect(res.applied.size).to.equal(0)
    })

    it('calls a database with no tables empty, not unreadable', async () => {
        const res = await readAppliedMigrations(target, { runner: runnerFor({ tables: 0 }) })
        expect(res.state).to.equal('empty-database')
    })

    it('calls a populated database with no ledger table UNREADABLE, never empty', async () => {
        // Waving this through would be the whole outage again: a real schema whose
        // migration state nobody can see.
        const res = await readAppliedMigrations(target, { runner: runnerFor({ tables: 40, ledger: 0 }) })
        expect(res.state).to.equal('unreadable')
        expect(res.reason).to.contain('schema_migrations')
    })
}

function registerUnreadableLedgerTests({ expect, readAppliedMigrations }, target) {
    it('refuses an unreadable table count instead of collapsing it into empty-database', async () => {
        // A count that fails to parse (a driver notice, an empty batch-mode
        // reply, garbage) yields NaN. `!NaN` is true just like `!0`, so a naive
        // falsy check reads an unreadable count as the same "empty database"
        // verdict as a genuinely empty one - the exact bug this guards against.
        const res = await readAppliedMigrations(target, {
            runner: async () => 'ERROR 2013 (HY000): Lost connection to MySQL server'
        })
        expect(res.state).to.equal('unreadable')
        expect(res.reason).to.contain(target.database)
    })

    it('refuses an empty-string table count instead of reading it as zero', async () => {
        const res = await readAppliedMigrations(target, { runner: async () => '' })
        expect(res.state).to.equal('unreadable')
    })

    it('refuses an unreadable ledger-presence count instead of reading it as "no ledger"', async () => {
        const res = await readAppliedMigrations(target, {
            runner: async (sql) => {
                if (/TABLE_NAME = 'schema_migrations'/.test(sql)) return 'ERROR: connection reset'
                if (/COUNT\(\*\)/.test(sql)) return '40'
                return ''
            }
        })
        expect(res.state).to.equal('unreadable')
        expect(res.reason).to.contain('schema_migrations')
    })

    it('turns a driver failure into unreadable instead of throwing past the guard', async () => {
        // A throw here would escape assertRequiredMigrationsApplied as an opaque
        // driver error, and the operator would read ECONNREFUSED with no idea a
        // migration was at stake.
        const res = await readAppliedMigrations(target, {
            runner: async () => { throw new Error('ECONNREFUSED 127.0.0.1:13306') }
        })
        expect(res.state).to.equal('unreadable')
        expect(res.reason).to.contain('ECONNREFUSED')
    })

    it('refuses a database name that is not a plain identifier, before any query runs', async () => {
        let called = false
        const res = await readAppliedMigrations(
            { database: 'x`; DROP DATABASE y; -- ', coin: 'bitcoin', network: 'mainnet' },
            { runner: async () => { called = true; return '0' } })
        expect(res.state).to.equal('unreadable')
        expect(called, 'nothing may reach SQL').to.equal(false)
    })
}

function registerAppliedLedger(deps) {
    const { GATED } = deps
    describe('readAppliedMigrations', () => {

        const target = { database: 'XChain_BTC_Mainnet_Indexer', coin: 'bitcoin', network: 'mainnet' }

        // Fake mariadb batch-mode output: one value per COUNT query, newline-joined
        // names for the ledger read - the exact shapes `-B -N` produces.
        function runnerFor({ tables = 40, ledger = 1, names = [GATED] }) {
            return async (sql) => {
                if (/TABLE_NAME = 'schema_migrations'/.test(sql)) return String(ledger)
                if (/COUNT\(\*\)/.test(sql)) return String(tables)
                return names.join('\n')
            }
        }

        registerReadableLedgerTests(deps, target, runnerFor)
        registerUnreadableLedgerTests(deps, target)
    })
}

module.exports = registerAppliedLedger
