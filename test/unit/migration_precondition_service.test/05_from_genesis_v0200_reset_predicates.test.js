'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const { SYNTHESIZED_ROWS, resetSchemaModel, unsatisfiedSchemaModel, readResetLedger } = require('./helpers/reset_schema_state')

describe('from-genesis v0.20.0 reset predicates', () => {
    it('evaluates all 18 generated predicates and finds each satisfied by the reset schema', async () => {
        const { evaluated, satisfied } = await readResetLedger(resetSchemaModel())

        expect(evaluated).to.have.members([...SYNTHESIZED_ROWS]).and.have.length(18)
        expect(satisfied).to.have.members([...SYNTHESIZED_ROWS]).and.have.length(18)
    })

    it('evaluates all 18 generated predicates and finds none satisfied by an unmigrated schema', async () => {
        const { evaluated, satisfied } = await readResetLedger(unsatisfiedSchemaModel())

        expect(evaluated).to.have.members([...SYNTHESIZED_ROWS]).and.have.length(18)
        expect(satisfied).to.deep.equal([])
    })
})
