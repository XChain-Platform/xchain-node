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

const { expect } = require('chai')
const sinon = require('sinon')

const { stakeValidator, unstakeValidator } = require('../../../src/services/validator_stake_service')
const { readValidatorSet } = require('../../../src/services/validator_stake_service/validator_set_read')
const { COIN_NETWORKS } = require('../../../src/services/validator_service')

const PUBKEY  = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'
const TIP     = 150400

// One stakes row per action, the shape /validators returns.
function stakeRow(actionIndex, pubkey) {
    return { status: 'valid', signing_pubkey: pubkey, source: ADDRESS, amount: '25000',
        action_index: String(actionIndex), activation_block: '1' }
}

// The target validator staked first, then 150 others, so it is the OLDEST row
// and sits off the newest-first first page the explorer serves by default.
function busySet() {
    const rows = [stakeRow(5, PUBKEY)]
    for (let i = 0; i < 150; i++) rows.push(stakeRow(100 + i, 'ff'.repeat(31) + String(10 + (i % 90)).padStart(2, '0')))
    return rows
}

// A /validators endpoint that pages the way the explorer does: `page` from 1,
// `limit` capped at 100, newest first unless sortorder=ASC, `total` the whole set.
function pagedValidators(rows, fault = {}) {
    return sinon.stub().callsFake(async (opts = {}) => {
        const limit = Math.max(1, Math.min(Number(opts.limit) || 100, 100))
        const page  = Math.max(1, Number(opts.page) || 1)
        if (fault.rejectPage === page) throw new Error('explorer 503')
        const asc  = String(opts.sortorder || 'DESC').toUpperCase() === 'ASC'
        const ordered = asc ? rows.slice() : rows.slice().reverse()
        const data = fault.emptyPage === page ? [] : ordered.slice((page - 1) * limit, page * limit)
        return { total: rows.length, data }
    })
}

function makeSdk(getValidators) {
    const calls = { submit: [] }
    const sdk = {
        explorer: {
            getAddress: sinon.stub().resolves({ balances: { confirmed: '0.001', pending: '0' } }),
            getToken:   sinon.stub().resolves({ mints: { max: 10000, address_max: 50000 } }),
            getValidators,
            getStatus:  sinon.stub().resolves({ last_block: Object.fromEntries(
                Object.values(COIN_NETWORKS).map(c => [c.stake, TIP])) })
        },
        getBalances: async () => ({ data: [{ tick: 'XCHAIN', amount: '25000' }] }),
        session: () => ({
            address: ADDRESS,
            submit: async (a) => { calls.submit.push(a); return { txid: 'tx' + calls.submit.length, spentInputs: [] } }
        }),
        requireEncoder: () => ({ getUTXOs: async () => ({ utxos: [] }) })
    }
    return { sdk, calls }
}

function deps(sdk, logged) {
    return {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
        wallets:  { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk:  () => sdk,
        sdk:      {},
        log:      m => logged.push(String(m))
    }
}

describe('ValidatorStakeService', function () {

    describe('validator set paging', function () {

        it('stake finds a stake that sits past the first page and sends nothing', async function () {
            const { sdk, calls } = makeSdk(pagedValidators(busySet()))
            const logged = []
            const result = await stakeValidator({ broadcast: true }, deps(sdk, logged))
            expect(result.staked).to.be.false
            expect(result.existing.action_index).to.equal('5')
            expect(calls.submit).to.have.length(0)
            expect(logged.join('\n')).to.include('already carries a valid STAKE')
        })

        it('stake reports an unreadable page as unknown, never as "not staked"', async function () {
            const { sdk } = makeSdk(pagedValidators(busySet(), { rejectPage: 2 }))
            const logged = []
            await stakeValidator({}, deps(sdk, logged))
            expect(logged.join('\n')).to.include('could not read the validator set')
        })

        it('stake reports a page that comes back short of the total as unknown', async function () {
            const { sdk } = makeSdk(pagedValidators(busySet(), { emptyPage: 2 }))
            const logged = []
            await stakeValidator({}, deps(sdk, logged))
            expect(logged.join('\n')).to.include('could not read the validator set (validator set read incomplete')
        })
    })
})

describe('ValidatorStakeService', function () {

    describe('validator set paging', function () {

        it('unstake finds a stake that sits past the first page', async function () {
            const { sdk, calls } = makeSdk(pagedValidators(busySet()))
            const logged = []
            const result = await unstakeValidator({}, deps(sdk, logged))
            expect(result.dryRun).to.be.true
            expect(result.nothingStaked).to.not.equal(true)
            expect(calls.submit).to.have.length(0)
        })

        it('unstake refuses and sends nothing when a page cannot be read', async function () {
            const { sdk, calls } = makeSdk(pagedValidators(busySet(), { rejectPage: 2 }))
            let err = null
            try { await unstakeValidator({ broadcast: true }, deps(sdk, [])) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/could not read the validator set/)
            expect(calls.submit).to.have.length(0)
        })
    })
})

describe('ValidatorStakeService', function () {

    describe('validator set paging', function () {

        it('pages oldest first from page 1 and stops at the total', async function () {
            const getValidators = pagedValidators(busySet())
            const set = await readValidatorSet({ explorer: { getValidators } })
            expect(getValidators.firstCall.args[0]).to.deep.equal({ page: 1, limit: 100, sortorder: 'ASC' })
            expect(getValidators.callCount).to.equal(2)
            expect(set.data).to.have.length(151)
            expect(set.data[0].action_index, 'oldest first, in the order it was paged').to.equal('5')
            expect(set.data[150].action_index).to.equal('249')
        })

        it('treats a short page with no total as the whole set', async function () {
            const getValidators = sinon.stub().resolves({ data: [stakeRow(1, PUBKEY)] })
            const set = await readValidatorSet({ explorer: { getValidators } })
            expect(getValidators.callCount).to.equal(1)
            expect(set.data).to.have.length(1)
        })

        it('refuses a response with no data array rather than reading it as empty', async function () {
            const getValidators = sinon.stub().resolves({ error: 'unexpected' })
            let err = null
            try { await readValidatorSet({ explorer: { getValidators } }) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/validator set read incomplete/)
        })
    })
})
