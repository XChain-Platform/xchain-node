'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const { SYNTHESIZED_ROWS, resetSchemaModel, unsatisfiedSchemaModel, readResetLedger } = require('./helpers/reset_schema_state')

// Facts for migrations newer than the v0.20.0 reset: evaluated, never satisfied by its schema.
const POST_RESET_FACTS = ['2026-09-22-oracle-prices-widen-tick.sql', '2026-09-30-list-share-tables.sql']
const MIRROR_ID_REPAIR = '2026-06-10-mirror-id-autoincrement-repair.sql'
const MIRROR_ID_TABLES = ['price_snapshots', 'cross_chain_matches', 'capability_snapshots', 'state_checkpoints']

async function mirrorIdRepairSatisfied(updateColumns) {
    const model = resetSchemaModel()
    const mirrorIds = model.columns.filter(column =>
        column.column_name === 'id' && MIRROR_ID_TABLES.includes(column.table_name))
    model.columns = model.columns.filter(column => !mirrorIds.includes(column))
    model.columns.push(...updateColumns(mirrorIds))
    return (await readResetLedger(model)).satisfied.includes(MIRROR_ID_REPAIR)
}

describe('from-genesis v0.20.0 reset predicates', () => {
    it('evaluates all 21 generated predicates and finds the 19 v0.19.0 rows satisfied by the reset schema', async () => {
        const { evaluated, satisfied } = await readResetLedger(resetSchemaModel())

        expect(evaluated).to.have.members([...SYNTHESIZED_ROWS, ...POST_RESET_FACTS]).and.have.length(21)
        expect(satisfied).to.have.members([...SYNTHESIZED_ROWS]).and.have.length(19)
    })

    it('evaluates all 21 generated predicates and finds none satisfied by an unmigrated schema', async () => {
        const { evaluated, satisfied } = await readResetLedger(unsatisfiedSchemaModel())

        expect(evaluated).to.have.members([...SYNTHESIZED_ROWS, ...POST_RESET_FACTS]).and.have.length(21)
        expect(satisfied).to.deep.equal([])
    })

    it('requires all four mirror ids to be bigint auto-increment columns while allowing either signedness', async () => {
        expect(await mirrorIdRepairSatisfied(columns => columns)).to.equal(true)
        expect(await mirrorIdRepairSatisfied(columns =>
            columns.map(column => ({ ...column, column_type: 'bigint' })))).to.equal(true)
        expect(await mirrorIdRepairSatisfied(columns => columns.slice(1))).to.equal(false)
        expect(await mirrorIdRepairSatisfied(columns =>
            columns.map((column, index) => index ? column : { ...column, data_type: 'int', column_type: 'int' }))).to.equal(false)
        expect(await mirrorIdRepairSatisfied(columns =>
            columns.map((column, index) => index ? column : { ...column, extra: '' }))).to.equal(false)
    })
})
