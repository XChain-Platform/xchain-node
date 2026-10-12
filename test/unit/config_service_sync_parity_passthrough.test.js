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
const defaults = require('../../src/services/config_service/defaults')

function viewsFor(env) {
    return bindEnvViews({ read: (n) => env[n], copy: () => ({ ...env }) })
}

function sharedDefaultsWith(env) {
    const views = viewsFor(env)
    defaults.configure({
        config: { ...views }, Network: {}, Coin: {}, CoinTickerSymbol: {}, XChainService: {}, DB_SEP: "_",
        bootstrapDir: "/tmp", NODE_MODULE_NAME: "node", HUB_MODULE_NAME: "hub",
        EXPLORER_MODULE_NAME: "explorer", SYNC_MODULE_NAME: "sync",
        getDockerContainerImageName: (m) => m, getModuleDatabaseName: (m) => m
    })
    const values = defaults.createSharedDefaults()
    defaults.configureSharedBeforeHubKey(values)
    return values
}

describe('sync INDEX_MAP_PARITY_CHECK passthrough', () => {
    it('the view answers the host value', () => {
        expect(viewsFor({ INDEX_MAP_PARITY_CHECK: 'true' }).SYNC_PASSTHROUGH_ENV.INDEX_MAP_PARITY_CHECK).to.equal('true')
    })

    it('the view rejects an undeclared name', () => {
        expect(() => viewsFor({}).SYNC_PASSTHROUGH_ENV.NOT_DECLARED).to.throw(/not declared/)
    })

    it('shared defaults carry the host value', () => {
        expect(sharedDefaultsWith({ INDEX_MAP_PARITY_CHECK: 'true' }).INDEX_MAP_PARITY_CHECK).to.equal('true')
    })

    it('shared defaults omit it when unset or empty', () => {
        expect(sharedDefaultsWith({}).INDEX_MAP_PARITY_CHECK).to.equal(undefined)
        expect(sharedDefaultsWith({ INDEX_MAP_PARITY_CHECK: '' }).INDEX_MAP_PARITY_CHECK).to.equal(undefined)
    })
})
