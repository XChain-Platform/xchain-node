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

const { readTokenRow } = require('../../../../src/services/validator_stake_service/token_balance_read')

function recordingSdk(responder) {
    const opts = []
    return {
        opts,
        async getBalances(address, requestOpts) {
            opts.push(requestOpts)
            return responder(address, requestOpts)
        }
    }
}

async function expectIncomplete(read) {
    let failure
    try {
        await read
    } catch (err) {
        failure = err
    }
    expect(failure).to.be.an('error')
    expect(failure.message).to.match(/^balance list read incomplete/)
    expect(failure.incompleteRead).to.equal(true)
}

describe('validator stake token balance read', function () {
    it('returns a matching row from the first page with the bounded request', async function () {
        const row = { tick: 'XC', balance: '12' }
        const sdk = recordingSdk(() => ({ data: [{ tick: 'AA' }, row], total: 2 }))

        expect(await readTokenRow(sdk, 'address-1', 'XC')).to.equal(row)
        expect(sdk.opts).to.deep.equal([{ page: 1, limit: 500, sortorder: 'ASC' }])
    })

    it('returns null when the reported total equals the rows seen', async function () {
        const sdk = recordingSdk(() => ({ data: [{ tick: 'AA' }, { tick: 'BB' }], total: 2 }))

        expect(await readTokenRow(sdk, 'address-1', 'XC')).to.equal(null)
        expect(sdk.opts).to.have.length(1)
    })

    it('returns null for a short page when no total is reported', async function () {
        const sdk = recordingSdk(() => ({ data: [{ tick: 'AA' }] }))

        expect(await readTokenRow(sdk, 'address-1', 'XC')).to.equal(null)
        expect(sdk.opts).to.have.length(1)
    })

    it('rejects a response without a data array as incomplete', async function () {
        const sdk = recordingSdk(() => ({ total: 1 }))

        await expectIncomplete(readTokenRow(sdk, 'address-1', 'XC'))
        expect(sdk.opts).to.have.length(1)
    })

    it('rejects when the reported total shrinks between pages', async function () {
        const rows = Array.from({ length: 500 }, (_, index) => ({ tick: 'T' + index }))
        const sdk = recordingSdk((address, opts) => ({ data: rows, total: opts.page === 1 ? 1000 : 999 }))

        await expectIncomplete(readTokenRow(sdk, 'address-1', 'XC'))
        expect(sdk.opts).to.have.length(2)
    })

    it('rejects an empty page before the reported total is reached', async function () {
        const sdk = recordingSdk(() => ({ data: [], total: 1 }))

        await expectIncomplete(readTokenRow(sdk, 'address-1', 'XC'))
        expect(sdk.opts).to.have.length(1)
    })

    it('rejects after the maximum readable pages without fetching another page', async function () {
        const rows = Array.from({ length: 500 }, (_, index) => ({ tick: 'T' + index }))
        const sdk = recordingSdk(() => ({ data: rows }))

        await expectIncomplete(readTokenRow(sdk, 'address-1', 'XC'))
        expect(sdk.opts).to.have.length(201)
        expect(sdk.opts[200]).to.deep.equal({ page: 201, limit: 500, sortorder: 'ASC' })
    })
})
