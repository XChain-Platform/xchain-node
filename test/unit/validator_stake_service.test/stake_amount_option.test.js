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

// --amount is a free string from the command line: the default applies only when it is absent, and
// anything that is not whole XCHAIN above 0 refuses instead of being truncated or replaced.

const { expect } = require('chai')

const { run } = require('../../helpers/stake_harness')

// Run a stake and hand back the refusal, or null with the run when it went through.
async function attempt(opts, chain) {
    try {
        return { err: null, ...(await run(opts, chain)) }
    } catch (err) {
        return { err, result: null, calls: null, logged: [] }
    }
}

describe('ValidatorStakeService', function () {

    describe('stakeValidator() --amount', function () {

        it('stakes the 25000 default when --amount is absent', async function () {
            const { err, calls } = await attempt({ broadcast: true }, { xchain: 30000 })
            expect(err).to.equal(null)
            expect(calls.stake).to.have.length(1)
            expect(calls.stake[0].params.AMOUNT).to.equal('25000')
        })

        it('stakes exactly the whole amount asked for', async function () {
            const { err, calls, logged } = await attempt({ amount: '1500', broadcast: true }, { xchain: 30000 })
            expect(err).to.equal(null)
            expect(calls.stake[0].params.AMOUNT).to.equal('1500')
            expect(logged.join('\n')).to.include('STAKE v1: 1500 XCHAIN')
        })

        it('refuses a malformed amount, dry run or --broadcast, and sends nothing', async function () {
            for (const amount of ['1500.5', '25,000', '0', 'abc', '', '1e3', '-5', '0x10', '99999999999999999999']) {
                for (const opts of [{ amount }, { amount, broadcast: true }]) {
                    const { err } = await attempt(opts, { xchain: 0 })
                    expect(err, JSON.stringify(opts)).to.exist
                    expect(err.message).to.include('--amount must be a whole number of XCHAIN above 0')
                    expect(err.message).to.include('(got "' + amount + '")')
                    expect(err.message).to.include('Nothing was sent')
                }
            }
        })
    })
})
