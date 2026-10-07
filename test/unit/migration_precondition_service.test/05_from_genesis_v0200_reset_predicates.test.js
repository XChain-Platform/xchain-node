'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const { SYNTHESIZED_ROWS, resetSchemaModel, unsatisfiedSchemaModel, readResetLedger } = require('./helpers/reset_schema_state')

// Facts for migrations newer than the v0.20.0 reset: evaluated, never satisfied by its schema.
const POST_RESET_FACTS = ['2026-09-22-oracle-prices-widen-tick.sql', '2026-09-30-list-share-tables.sql']

describe('from-genesis v0.20.0 reset predicates', () => {
    it('evaluates all 20 generated predicates and finds the 18 v0.19.0 rows satisfied by the reset schema', async () => {
        const { evaluated, satisfied } = await readResetLedger(resetSchemaModel())

        expect(evaluated).to.have.members([...SYNTHESIZED_ROWS, ...POST_RESET_FACTS]).and.have.length(20)
        expect(satisfied).to.have.members([...SYNTHESIZED_ROWS]).and.have.length(18)
    })

    it('evaluates all 20 generated predicates and finds none satisfied by an unmigrated schema', async () => {
        const { evaluated, satisfied } = await readResetLedger(unsatisfiedSchemaModel())

        expect(evaluated).to.have.members([...SYNTHESIZED_ROWS, ...POST_RESET_FACTS]).and.have.length(20)
        expect(satisfied).to.deep.equal([])
    })
})
