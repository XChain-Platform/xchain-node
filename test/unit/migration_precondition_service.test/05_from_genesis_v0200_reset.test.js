'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const { XChainService } = require('../../../src/config')
const { assertRequiredMigrationsApplied } = require('../../../src/services/migration_precondition_service')
const { migrationDeclaresDeployPrecondition } = require('../../../src/services/migration_precondition_service/migration_scan')
const {
    V0190_MIGRATIONS, PRECONDITION_MIGRATIONS, resetLedger, resetSchemaModel,
    unsatisfiedSchemaModel, readResetLedger
} = require('./helpers/reset_schema_state')

function v0190MigrationSource(name) {
    const required = PRECONDITION_MIGRATIONS.has(name) ? ' deploy-precondition=required' : ''
    return '-- xchain:migration mode=manual' + required + "\nSELECT '" + name + "'"
}

function scanV0190Preconditions() {
    return V0190_MIGRATIONS.filter(name => migrationDeclaresDeployPrecondition(v0190MigrationSource(name)))
}

function runDowngradeGuard(result) {
    return assertRequiredMigrationsApplied(
        XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'v0.19.0', {
            cloneGit: async () => {},
            listDeployPreconditionMigrations: scanV0190Preconditions,
            readAppliedMigrations: async () => result,
            runningBuildSupportsPerFileMigrations: async () => true,
            pendingManualMigrations: () => []
        })
}

async function downgradeRefusal(result) {
    try {
        await runDowngradeGuard(result)
    } catch (err) {
        return err
    }
    return null
}

describe('from-genesis v0.20.0 migration ledger', () => {
    it('earns all 82 v0.19.0 rows from the reset schema and passes the real precondition scan', async () => {
        expect(resetLedger()).to.have.length(68)

        const { result, ledger, queries } = await readResetLedger(resetSchemaModel())

        expect(result.state, result.reason).to.equal('ledger')
        expect([...result.applied].filter(name => V0190_MIGRATIONS.includes(name)))
            .to.have.members(V0190_MIGRATIONS).and.have.length(82)
        expect([...result.applied]).to.have.length(83)
        expect(ledger).to.have.length(68)
        expect(queries.some(sql => /^INSERT INTO /i.test(sql))).to.equal(false)
        expect(scanV0190Preconditions()).to.have.members([...PRECONDITION_MIGRATIONS])
        expect(await runDowngradeGuard(result)).to.deep.equal({
            checked: true,
            required: scanV0190Preconditions(),
            missing: [],
            ok: true
        })
    })

    it('keeps the v0.19.0 downgrade refused when every generated predicate is false', async () => {
        const { result, ledger, queries } = await readResetLedger(unsatisfiedSchemaModel())

        expect(result.state, result.reason).to.equal('ledger')
        expect([...result.applied]).to.have.length(68)
        expect(ledger).to.have.length(68)
        expect(queries.some(sql => /^INSERT INTO /i.test(sql))).to.equal(false)
        const refusal = await downgradeRefusal(result)
        expect(refusal, 'the downgrade must stay refused').to.be.an('error')
        expect(refusal.message).to.include('2026-09-12-bridge-tables.sql')
    })
})
