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

// Guards the contract HubService's config-push retry loop depends on for its
// error message.
//
// THE DEFECT THIS EXISTS FOR. `_call()` catches its own transport errors and
// returns null, so `updateConfig()` reports failure by RETURNING FALSE rather
// than throwing. The retry loop only recorded a cause in its `catch`, so the
// one path that never throws - a 401 from a key-enforcing hub - printed
// "There was a problem trying to update a config in the xchain-hub module"
// and nothing else, dropping the single most informative fact about the
// failure. Observed verbatim during a real regtest hub deploy on 2026-08-30.
// `lastFailures` already carried the reason; the loop simply never read it.
//
// SCOPE. These tests pin the connector half: a non-throwing failure still
// records WHY, per endpoint. They do not drive `updateHubOrExplorer` itself,
// which needs docker, a module registry and a live status snapshot; the loop's
// use of `lastFailures` is a four-line read guarded by this contract holding.

const { expect } = require('chai')
const http       = require('http')
const HubConnector = require('../../src/HubConnector')

function server(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler)
        s.listen(0, '127.0.0.1', () => resolve(s))
    })
}

describe('HubConnector: a non-throwing failure still records why', () => {
    let srv

    afterEach(async () => {
        if (srv) await new Promise((r) => srv.close(r))
        srv = null
    })

    it('a 401 makes updateConfig return false AND records the status in lastFailures', async () => {
        srv = await server((req, res) => { res.writeHead(401); res.end('unauthorized') })
        const c = new HubConnector('127.0.0.1', srv.address().port)

        const ok = await c.updateConfig({ any: 'config' })

        // This is the shape that fooled the retry loop: falsy, but nothing thrown.
        expect(ok).to.equal(false)
        expect(c.lastFailures).to.be.an('array').that.is.not.empty
        expect(c.lastFailures.join('; ')).to.match(/401/)
    })

    it('an unreachable endpoint records the connection code, not a bare null', async () => {
        // Bind then immediately close, so the port is almost certainly dead.
        srv = await server((req, res) => res.end())
        const port = srv.address().port
        await new Promise((r) => srv.close(r))
        srv = null

        const c = new HubConnector('127.0.0.1', port)
        const ok = await c.updateConfig({ any: 'config' })

        expect(ok).to.equal(false)
        expect(c.lastFailures.join('; ')).to.match(/ECONNREFUSED|ECONNRESET|socket hang up/)
    })

    it('names every endpoint it tried, so a multi-endpoint failure is diagnosable', async () => {
        srv = await server((req, res) => { res.writeHead(401); res.end('nope') })
        const live = 'http://127.0.0.1:' + srv.address().port
        const dead = 'http://127.0.0.1:1'
        const c = new HubConnector([live, dead])

        const ok = await c.updateConfig({ any: 'config' })

        expect(ok).to.equal(false)
        expect(c.lastFailures).to.have.lengthOf(2)
        expect(c.lastFailures.join('; ')).to.include(live)
        expect(c.lastFailures.join('; ')).to.include(dead)
    })

    it('a successful push clears the previous failures rather than leaving them stale', async () => {
        srv = await server((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'success' } }))
        })
        const c = new HubConnector('127.0.0.1', srv.address().port)
        c.lastFailures = ['stale → from an earlier call']

        const ok = await c.updateConfig({ any: 'config' })

        // A stale reason attached to a later success would send an operator
        // chasing a failure that already resolved.
        expect(ok).to.equal(true)
        expect(c.lastFailures).to.be.an('array').that.is.empty
    })
})
