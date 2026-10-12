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
const { bindEnvViews } = require('../../src/config/env_views')
const {
    makeServiceWithConfig,
    DB_MODULE_NAME,
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME
} = require('./config_service.test/helpers.test')

function viewsFor(env) {
    return bindEnvViews({ read: (n) => env[n], copy: () => ({ ...env }) })
}

async function withParityValue(value, fn) {
    const previous = process.env.INDEX_MAP_PARITY_CHECK
    if (value === undefined) delete process.env.INDEX_MAP_PARITY_CHECK
    else process.env.INDEX_MAP_PARITY_CHECK = value
    try {
        await fn()
    } finally {
        if (previous === undefined) delete process.env.INDEX_MAP_PARITY_CHECK
        else process.env.INDEX_MAP_PARITY_CHECK = previous
    }
}

async function containerConfig(module) {
    return makeServiceWithConfig('').getDefaultConfig(module, null, null)
}

describe('sync INDEX_MAP_PARITY_CHECK passthrough', () => {
    it('the view answers the host value', () => {
        expect(viewsFor({ INDEX_MAP_PARITY_CHECK: 'true' }).SYNC_PASSTHROUGH_ENV.INDEX_MAP_PARITY_CHECK).to.equal('true')
    })

    it('the view rejects an undeclared name', () => {
        expect(() => viewsFor({}).SYNC_PASSTHROUGH_ENV.NOT_DECLARED).to.throw(/not declared/)
    })

    it('puts the host value in the sync container config', async () => {
        await withParityValue('true', async () => {
            const config = await containerConfig(SYNC_MODULE_NAME)
            expect(config).to.have.property('INDEX_MAP_PARITY_CHECK', 'true')
        })
    })

    it('does not put the host value in other shared container configs', async () => {
        await withParityValue('true', async () => {
            for (const module of [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, DB_MODULE_NAME]) {
                const config = await containerConfig(module)
                expect(config).to.not.have.property('INDEX_MAP_PARITY_CHECK')
            }
        })
    })

    it('omits the value from the sync container config when unset or empty', async () => {
        for (const value of [undefined, '']) {
            await withParityValue(value, async () => {
                const config = await containerConfig(SYNC_MODULE_NAME)
                expect(config).to.not.have.property('INDEX_MAP_PARITY_CHECK')
            })
        }
    })
})
