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

// An owned top-up still inside its activation delay, beside an active stake. The indexer's UNSTAKE
// deactivates only rows already active, so the top-up activates afterwards and keeps the key in N.

const { expect } = require('chai')

const { unstakeValidator } = require('../../../src/services/validator_stake_service')
const { PUBKEY, ADDRESS, makeSdk } = require('../../helpers/stake_harness')

const TIP    = 200000
const ACTIVE = { status: 'valid', signing_pubkey: PUBKEY, source: ADDRESS, amount: '25000', action_index: '44',
    activation_block: '199000' }
const topUp  = (action_index, amount, activation_block) =>
    ({ ...ACTIVE, action_index, amount, activation_block: String(activation_block) })

// Run unstakeValidator against the shared fake SDK; resolves to the refusal, or to the run when it did not refuse.
async function runUnstake(opts, stakeRows) {
    const { sdk } = makeSdk({ existing: ACTIVE, stakeRows, tip: TIP })
    const unstakeCalls = []
    const origSession = sdk.session
    sdk.session = () => {
        const s = origSession()
        const inner = s.submit
        s.submit = async (a, e, o) => { if (a.action === 'UNSTAKE') unstakeCalls.push(a.params); return inner(a, e, o) }
        return s
    }
    const logged = []
    const deps = {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
        wallets:  { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk:  () => sdk,
        sdk:      {},
        log:      m => logged.push(String(m))
    }
    try {
        const result = await unstakeValidator(opts, deps)
        return { err: null, result, unstakeCalls, logged }
    } catch (err) {
        return { err, result: null, unstakeCalls, logged }
    }
}

describe('ValidatorStakeService', function () {

    describe('unstakeValidator() with an owned top-up still pending', function () {

        it('refuses a --broadcast run and names the pending row', async function () {
            const { err, unstakeCalls } = await runUnstake({ broadcast: true }, [topUp('61', '5000', TIP + 4)])
            expect(err, 'a partial exit must refuse').to.exist
            expect(unstakeCalls).to.have.length(0)
            expect(err.message).to.match(/not active yet/)
            expect(err.message).to.include('action 61')
            expect(err.message).to.include('5000 XCHAIN')
            expect(err.message).to.include('block ' + (TIP + 4))
            expect(err.message).to.include('Nothing was sent')
        })

        it('refuses the dry run the same way, before printing a plan', async function () {
            const { err, logged } = await runUnstake({}, [topUp('61', '5000', TIP + 4)])
            expect(err).to.exist
            expect(err.message).to.match(/not active yet/)
            expect(logged.join('\n')).to.not.include('Dry run')
        })

        it('names the LAST pending activation as the block a re-run covers everything from', async function () {
            const { err } = await runUnstake({ broadcast: true }, [topUp('61', '5000', TIP + 2), topUp('62', '1000', TIP + 5)])
            expect(err).to.exist
            expect(err.message).to.include('can land from block ' + (TIP + 5))
            expect(err.message).to.include('action 62')
        })

        it('withdraws the whole stake once the top-up has activated', async function () {
            const { err, unstakeCalls, logged } = await runUnstake({ broadcast: true }, [topUp('61', '5000', TIP + 1)])
            expect(err).to.equal(null)
            expect(unstakeCalls).to.have.length(1)
            expect(logged.join('\n')).to.include('active stake   : 30000 XCHAIN (action 44, 61')
        })
    })
})
