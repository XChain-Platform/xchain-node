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

// A stake address that put itself to sleep: the indexer rejects its MINTs, STAKE and UNSTAKE
// as 'invalid: SOURCE (sleeping)' only after the fees are spent, so the CLI refuses first.

const { expect } = require('chai')

const { stakeValidator, unstakeValidator } = require('../../../src/services/validator_stake_service')
const { judgeAddressSleep, readAddressSleep } = require('../../../src/services/validator_stake_service/address_sleep')
const { PUBKEY, ADDRESS, makeSdk, run } = require('../../helpers/stake_harness')

const TIP = 200000
const SLEPT = (action_index, resume_block, extra = {}) =>
    ({ source: ADDRESS, type: 1, tick: null, resume_block, status: 'valid', action_index, block_index: 150000, ...extra })
const STAKED = { status: 'valid', signing_pubkey: PUBKEY, source: ADDRESS, amount: '25000', action_index: '44',
    activation_block: '199000' }

// Run a command against a prepared fake SDK; resolves to the result or the refusal, with every send recorded.
async function runWith(command, opts, sdk) {
    const sent = []
    const origSession = sdk.session
    sdk.session = () => {
        const s = origSession()
        const inner = s.submit
        s.submit = async (a, e, o) => { sent.push(a.action); return inner(a, e, o) }
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
        return { err: null, result: await command(opts, deps), sent, logged }
    } catch (err) {
        return { err, result: null, sent, logged }
    }
}

const stakeChain = (extra) => ({ xchain: 5000, coin: '0.001', tip: TIP, ...extra })
const unstakeSdk = (extra) => makeSdk({ existing: STAKED, tip: TIP, ...extra }).sdk

// Registers the stake refusals and passes for a sleeping stake address.
function registerStakeRefusals () {
    for (const broadcast of [false, true]) {
        const mode = broadcast ? 'a --broadcast run' : 'the dry run'

        it('refuses ' + mode + ' when the address is asleep indefinitely', async function () {
            const { result, calls, logged } = await run({ broadcast }, stakeChain({ sleeps: [SLEPT(90, -1)] }))
            expect(result.staked).to.be.false
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(0)
            const out = logged.join('\n')
            expect(out).to.match(/BLOCKED: .*asleep indefinitely/)
            expect(out).to.include('cannot wake itself')
            expect(out).to.not.include('Dry run')
        })

        it('refuses ' + mode + ' when the sleep read fails', async function () {
            const { result, calls, logged } = await run({ broadcast }, stakeChain({ sleepsThrow: 'explorer 503' }))
            expect(result.staked).to.be.false
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(0)
            expect(logged.join('\n')).to.match(/BLOCKED: could not confirm the stake address .* is not asleep \(explorer 503\)/)
        })
    }

    it('refuses until the resume block when the sleep ends after the next block', async function () {
        const { result, calls, logged } = await run({ broadcast: true }, stakeChain({ sleeps: [SLEPT(90, TIP + 2)] }))
        expect(result.staked).to.be.false
        expect(calls.mint).to.have.length(0)
        expect(logged.join('\n')).to.match(/BLOCKED: .*asleep until block 200002/)
    })

    it('refuses when the SDK has no sleep lookup, never reading that as awake', async function () {
        const { sdk } = makeSdk(stakeChain())
        delete sdk.explorer.getSleeps
        const { result, sent, logged } = await runWith(stakeValidator, { broadcast: true }, sdk)
        expect(result.staked).to.be.false
        expect(sent).to.have.length(0)
        expect(logged.join('\n')).to.include('this SDK has no getSleeps')
    })

    it('stakes when the sleep resumes at the next block', async function () {
        const { result, calls } = await run({ broadcast: true }, stakeChain({ sleeps: [SLEPT(90, TIP + 1)] }))
        expect(result.staked).to.be.true
        expect(calls.stake).to.have.length(1)
    })

    it('stakes when a newer resume-now SLEEP supersedes an older indefinite one', async function () {
        const { result } = await run({ broadcast: true }, stakeChain({ sleeps: [SLEPT(9, -1), SLEPT(10, 0)] }))
        expect(result.staked).to.be.true
    })
}

// Registers the unstake refusals and passes for a sleeping owner.
function registerUnstakeRefusals () {
    for (const broadcast of [false, true]) {
        it('refuses ' + (broadcast ? 'a --broadcast run' : 'the dry run') + ' when the owner is asleep indefinitely', async function () {
            const { err, sent, logged } = await runWith(unstakeValidator, { broadcast }, unstakeSdk({ sleeps: [SLEPT(90, -1)] }))
            expect(err, 'a sleeping owner must refuse').to.exist
            expect(sent).to.have.length(0)
            expect(err.message).to.include('asleep indefinitely')
            expect(err.message).to.include('Nothing was sent')
            expect(logged.join('\n')).to.not.include('Dry run')
        })
    }

    it('refuses when the sleep read fails', async function () {
        const { err, sent } = await runWith(unstakeValidator, { broadcast: true }, unstakeSdk({ sleepsThrow: 'explorer 503' }))
        expect(err).to.exist
        expect(sent).to.have.length(0)
        expect(err.message).to.match(/could not confirm the stake address .* is not asleep \(explorer 503\)/)
    })

    it('withdraws when the sleep resumes at the next block', async function () {
        const { err, sent } = await runWith(unstakeValidator, { broadcast: true }, unstakeSdk({ sleeps: [SLEPT(90, TIP + 1)] }))
        expect(err).to.equal(null)
        expect(sent).to.deep.equal(['UNSTAKE'])
    })
}

// Registers the cases for deciding which address sleep row wins.
function registerJudgeCases () {
    it('lets only the newest valid address sleep from this address decide', function () {
        const rows = [
            SLEPT(9, -1),
            SLEPT(10, 0),
            SLEPT(11, -1, { status: 'invalid: SOURCE (sleeping)' }),
            SLEPT(12, -1, { type: 2, tick: 'FOO' }),
            SLEPT(13, -1, { source: 'mSomeoneElse' })
        ]
        expect(judgeAddressSleep(rows, ADDRESS, TIP + 1)).to.deep.equal({ sleeping: false, resumeBlock: 0, actionIndex: 10 })
    })

    it('orders by action index as a number, not as text', function () {
        const j = judgeAddressSleep([SLEPT('10', -1), SLEPT('9', 0)], ADDRESS, TIP + 1)
        expect(j).to.deep.equal({ sleeping: true, resumeBlock: -1, actionIndex: 10 })
    })

    it('reads a resume block equal to the landing block as awake and one past it as asleep', function () {
        expect(judgeAddressSleep([SLEPT(1, TIP + 1)], ADDRESS, TIP + 1).sleeping).to.be.false
        expect(judgeAddressSleep([SLEPT(1, TIP + 2)], ADDRESS, TIP + 1).sleeping).to.be.true
    })

    it('reads an address with no sleep rows as awake', function () {
        expect(judgeAddressSleep([], ADDRESS, TIP + 1)).to.deep.equal({ sleeping: false, resumeBlock: null, actionIndex: null })
    })

    it('throws on a deciding row whose resume block is not an integer', function () {
        expect(() => judgeAddressSleep([SLEPT(1, 'soon')], ADDRESS, TIP + 1)).to.throw(/resume block/)
    })
}

// Registers the cases for paging the address sleep lane.
function registerReadCases () {
    it('pages the address lane to the end in ascending order', async function () {
        const first = Array.from({ length: 100 }, (_, i) => SLEPT(i + 1, 0))
        const pages = [{ total: 101, data: first }, { total: 101, data: [SLEPT(500, -1)] }]
        const asked = []
        const sdk = { explorer: { getSleeps: async (q, t, o) => { asked.push([q, t, o]); return pages[o.page - 1] } } }
        const j = await readAddressSleep(sdk, ADDRESS, TIP + 1)
        expect(j).to.deep.equal({ sleeping: true, resumeBlock: -1, actionIndex: 500 })
        expect(asked[0]).to.deep.equal([ADDRESS, 'address', { page: 1, limit: 100, sortorder: 'ASC' }])
        expect(asked).to.have.length(2)
    })

    it('throws on a page with no row list and on a read cut short', async function () {
        const noList = { explorer: { getSleeps: async () => ({ error: 'no route' }) } }
        let err = null
        try { await readAddressSleep(noList, ADDRESS, TIP + 1) } catch (e) { err = e }
        expect(err && err.message).to.match(/no row list/)
        const short = { explorer: { getSleeps: async (q, t, o) => (o.page === 1
            ? { total: 150, data: Array.from({ length: 100 }, (_, i) => SLEPT(i + 1, 0)) }
            : { total: 150, data: [] }) } }
        err = null
        try { await readAddressSleep(short, ADDRESS, TIP + 1) } catch (e) { err = e }
        expect(err && err.message).to.match(/incomplete: saw 100 of 150/)
    })
}

describe('ValidatorStakeService', function () {
    describe('stakeValidator() from a sleeping stake address', registerStakeRefusals)
    describe('unstakeValidator() from a sleeping stake address', registerUnstakeRefusals)
    describe('judgeAddressSleep()', registerJudgeCases)
    describe('readAddressSleep()', registerReadCases)
})
