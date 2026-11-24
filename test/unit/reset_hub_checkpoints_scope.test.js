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
const { resetHubCheckpoints } = require('../../src/cli/reset_hub_checkpoints')

const COINS = ['bitcoin', 'litecoin', 'dogecoin']
const row = name => ({ ID: name + '-id', Names: name, State: 'running' })
// One stack per prefix, the way two sessions share a docker host.
function stack(prefix) {
    return [row(prefix + '-xchain-hub'), row(prefix + '-database'), row(prefix + '-xchain-explorer')]
        .concat(COINS.map(coin => row(`${prefix}-${coin}-regtest-xchain-indexer`)))
}
const LISTING = stack('xchain-node').concat(stack('xcsw1'))

function harness(listing, prefix) {
    const stops = [], starts = [], execs = []
    const nameOf = id => id.replace(/-id$/, '')
    const deps = {
        NODE_PREFIX: prefix, EXTERNAL_DB: false, HUB_MODULE_NAME: 'xchain-hub', INDEXER_MODULE_NAME: 'xchain-indexer',
        rootPassword: async () => 'dummy',
        stopContainer: async () => true,
        getContainerStopSettings: async () => null,
        stopModuleContainer: async (stop, service, a, b, id) => { stops.push(nameOf(id)) },
        startContainer: async (id) => { starts.push(nameOf(id)) },
        statusChanged: async () => {},
        execFileAsync: async (command, args) => {
            if (args[0] === 'ps') return { stdout: listing.map(c => JSON.stringify(c)).join('\n') }
            if (args[0] === 'inspect') {
                const n = nameOf(args[args.length - 1]).replace(/[^A-Za-z0-9]/g, '_')
                return { stdout: JSON.stringify(['HUB_DB_NAME=H_' + n, 'INDEXER_DB_NAME=I_' + n]) }
            }
            const database = args[args.length - 2], table = args[args.length - 1]
            execs.push({ container: nameOf(args[3]), database, script: args[6] })
            return { stdout: `| ${table} |\n` }
        }
    }
    return { deps, stops, starts, execs }
}

describe('reset hub-checkpoints scope: only the caller stack is touched', function () {
    it('leaves every foreign-prefix container and database alone', async function () {
        const h = harness(LISTING, 'xchain-node')
        expect(await resetHubCheckpoints(true, h.deps, { withCapabilities: true })).to.equal(true)
        expect(h.stops).to.have.length(5)
        for (const name of h.stops.concat(h.starts)) expect(name).to.match(/^xchain-node-/)
        expect(h.starts.slice().sort()).to.deep.equal(h.stops.slice().sort())
        expect(h.execs.length).to.be.greaterThan(0)
        for (const e of h.execs) {
            expect(e.container).to.equal('xchain-node-database')
            expect(e.database).to.not.match(/xcsw1/)
        }
    })

    it('scopes to xcsw1 when that is the caller prefix', async function () {
        const h = harness(LISTING, 'xcsw1')
        await resetHubCheckpoints(true, h.deps, {})
        expect(h.stops).to.have.length(5)
        for (const name of h.stops.concat(h.starts)) expect(name).to.match(/^xcsw1-/)
        for (const e of h.execs) expect(e.container).to.equal('xcsw1-database')
    })

    it('throws the no-hub error when only foreign hubs exist', async function () {
        const h = harness(stack('xcsw1'), 'xchain-node')
        let error = null
        try { await resetHubCheckpoints(true, h.deps, {}) } catch (err) { error = err }
        expect(error && error.message).to.match(/no rail hub container named xchain-node-xchain-hub/)
        expect(h.stops).to.deep.equal([])
        expect(h.execs.filter(e => !/mariadb-show/.test(e.script))).to.deep.equal([])
    })
})
