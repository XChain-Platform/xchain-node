'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// An indexer database can embody a manual migration's end state with no ledger
// row for it. That counts as applied when deciding what is missing, but the
// indexer runner decides from the ledger, so an unscoped migrate run still executes
// the file (unless its MIGRATION_PRECONDITIONS entry baselines it, which this
// fixture's file has none of): the refusal's "would apply" list has to name it.

const sinon = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../../src/config')
const { assertRequiredMigrationsApplied } = require('../../../src/services/migration_precondition_service')
const { readAppliedMigrations } = require('../../../src/services/migration_precondition_service/migration_scan')

const REQUIRED  = '2026-09-13-gated.sql'
const RECORDED  = '2026-05-01-recorded.sql'
const SATISFIED = '2026-07-15-markets-dedup-unique-pair.sql'

// Batch-mode answers by query: the counts, the ledger-plus-schema read, and the ledger-only read.
function runnerFor({ union, ledger, ledgerThrows = false }) {
    return async (sql) => {
        if (/TABLE_NAME = 'schema_migrations'/.test(sql)) return '1'
        if (/COUNT\(\*\)/.test(sql)) return '40'
        if (/ UNION /.test(sql)) return union.join('\n')
        if (ledgerThrows) throw new Error('Lost connection')
        return ledger.join('\n')
    }
}

function guardDeps({ applied, ledger, pendingManual }) {
    return {
        cloneGit: sinon.stub().resolves(),
        listDeployPreconditionMigrations: sinon.stub().returns([REQUIRED]),
        readAppliedMigrations: sinon.stub().resolves({ state: 'ledger', applied: new Set(applied),
            ...(ledger ? { ledger: new Set(ledger) } : {}) }),
        runningBuildSupportsPerFileMigrations: sinon.stub().resolves(false),
        pendingManualMigrations: sinon.stub().returns(pendingManual),
        readLedgerRenames: sinon.stub().returns({ state: 'absent', renames: {} })
    }
}

async function refusalOf(deps) {
    try {
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
    } catch (err) { return err }
    return null
}

describe('migration precondition guard: refusal lists against the recorded ledger', () => {
    let warn
    beforeEach(() => { warn = sinon.stub(console, 'warn') })
    afterEach(() => { warn.restore() })

    describe('readAppliedMigrations', () => {
        const indexer = { database: 'XChain_BTC_Mainnet_Indexer', coin: 'bitcoin', network: 'mainnet' }

        it('keeps the recorded names apart from the schema-satisfied ones on an indexer database', async () => {
            const res = await readAppliedMigrations(indexer, { runner: runnerFor({ union: [RECORDED, SATISFIED], ledger: [RECORDED] }) })
            expect(res.state).to.equal('ledger')
            expect([...res.applied]).to.have.members([RECORDED, SATISFIED])
            expect([...res.ledger]).to.have.members([RECORDED])
        })

        it('reads a decoder ledger once and reports it as both sets', async () => {
            const decoder = { database: 'XChain_BTC_Mainnet_Decoder', coin: 'bitcoin', network: 'mainnet' }
            const res = await readAppliedMigrations(decoder, { runner: async (sql) =>
                /TABLE_NAME = 'schema_migrations'/.test(sql) ? '1' : /COUNT\(\*\)/.test(sql) ? '40' : RECORDED })
            expect([...res.applied]).to.have.members([RECORDED])
            expect(res.ledger).to.equal(res.applied)
        })

        it('reports a failed ledger-only read as null without failing the applied read', async () => {
            const res = await readAppliedMigrations(indexer,
                { runner: runnerFor({ union: [RECORDED, SATISFIED], ledger: [], ledgerThrows: true }) })
            expect(res.state).to.equal('ledger')
            expect([...res.applied]).to.have.members([RECORDED, SATISFIED])
            expect(res.ledger).to.equal(null)
        })
    })

    describe('assertRequiredMigrationsApplied', () => {
        it('lists a schema-satisfied file with no ledger row among what an unscoped run applies', async () => {
            const deps = guardDeps({ applied: [RECORDED, SATISFIED], ledger: [RECORDED], pendingManual: [REQUIRED, SATISFIED] })
            const err = await refusalOf(deps)
            expect(err).to.be.an('error')
            const subtracted = deps.pendingManualMigrations.firstCall.args[1]
            expect(subtracted.has(RECORDED)).to.equal(true)
            expect(subtracted.has(SATISFIED)).to.equal(false)
            expect(err.message).to.contain('which is 2 file(s)')
            expect(err.message).to.contain(SATISFIED + '  (the live schema already matches it; no ledger row records it)')
            expect(err.message).to.contain(REQUIRED + '  (the one you need)')
        })

        it('still passes a required file the live schema already satisfies', async () => {
            const deps = guardDeps({ applied: [RECORDED, REQUIRED], ledger: [RECORDED], pendingManual: [] })
            expect(await refusalOf(deps)).to.equal(null)
        })

        it('falls back to the applied set when no recorded ledger was read', async () => {
            const deps = guardDeps({ applied: [RECORDED, SATISFIED], pendingManual: [REQUIRED] })
            const err = await refusalOf(deps)
            expect(err).to.be.an('error')
            expect(deps.pendingManualMigrations.firstCall.args[1].has(SATISFIED)).to.equal(true)
        })
    })
})
