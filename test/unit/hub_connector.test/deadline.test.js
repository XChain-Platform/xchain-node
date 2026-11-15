/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * HubConnector.callRpc: the per-call timeout is a total deadline, and an
 * optional budget bounds the whole call across endpoints.
 ********************************************************************/

const { expect } = require('chai')
const http = require('http')
const HubConnector = require('../../../src/services/hub_connector')

const RESULT = JSON.stringify({ jsonrpc: '2.0', result: 'ok', id: 1 })

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler)
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

// Sends the headers at once and then one byte per tick of the interval, so the
// socket never goes idle for long and only a total deadline can end the call.
function trickle(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' })
    const body = RESULT + ' '.repeat(2000)
    let at = 0
    const timer = setInterval(() => {
        if (at >= body.length) { clearInterval(timer); res.end(); return }
        res.write(body[at++])
    }, 20)
    res.on('close', () => clearInterval(timer))
}

const silent = () => {}
const url = (server) => 'http://127.0.0.1:' + server.address().port
const rpc = { jsonrpc: '2.0', method: 'ping', id: 1 }
const servers = []

async function start(handler) {
    const server = await listen(handler)
    servers.push(server)
    return server
}

async function closeServers() {
    while (servers.length) {
        const server = servers.pop()
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
}

function registerDeadlineCases() {
    it('cuts off a hub that sends headers and then trickles its body', async () => {
        const slow = await start(trickle)
        const c = new HubConnector([url(slow)])
        const startedAt = Date.now()

        const result = await c.callRpc(rpc, 300)

        expect(result).to.equal(null)
        expect(Date.now() - startedAt).to.be.below(1500)
        expect(c.lastFailures).to.have.length(1)
        expect(c.lastFailures[0]).to.match(/timeout: no complete response within 300ms/)
        expect(c.lastFailures[0]).to.not.match(/ERR_CANCELED/)
    })

    it('moves on from a trickling endpoint to a healthy one', async () => {
        const slow = await start(trickle)
        const good = await start((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(RESULT) })
        const c = new HubConnector([url(slow), url(good)])

        expect(await c.callRpc(rpc, 300)).to.equal('ok')
        expect(c.lastFailures).to.have.length(1)
        expect(c._lastGoodIdx).to.equal(1)
    })

    it('still returns the result of a prompt reply', async () => {
        const good = await start((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(RESULT) })
        const c = new HubConnector([url(good)])

        expect(await c.callRpc(rpc, 300)).to.equal('ok')
        expect(c.lastFailures).to.deep.equal([])
    })
}

function registerBudgetCases() {
    it('a budget caps an endpoint below its own timeout and skips the rest', async () => {
        const hung = await start(silent)
        let reached = 0
        const never = await start((req, res) => { reached++; res.end(RESULT) })
        const c = new HubConnector([url(hung), url(never)])
        const startedAt = Date.now()

        const result = await c.callRpc(rpc, 5000, 300)

        expect(result).to.equal(null)
        expect(Date.now() - startedAt).to.be.below(1500)
        expect(c.lastFailures.join('; ')).to.match(/within [0-9]+ms/)
        expect(c.lastFailures.join('; ')).to.contain('wall-clock budget exhausted')
        expect(reached).to.equal(0)
    })

    it('a budget left over after a fast failure still lets the next endpoint answer', async () => {
        const dead = await listen(silent)
        const deadUrl = url(dead)
        await new Promise((r) => dead.close(r))
        const good = await start((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(RESULT) })
        const c = new HubConnector([deadUrl, url(good)])

        expect(await c.callRpc(rpc, 300, 5000)).to.equal('ok')
    })

    it('updateConfig passes its budget through to the call', async () => {
        const hung = await start(silent)
        const c = new HubConnector([url(hung)])
        const startedAt = Date.now()

        expect(await c.updateConfig({ any: 'config' }, { budgetMs: 250 })).to.equal(false)
        expect(Date.now() - startedAt).to.be.below(1500)
        expect(c.lastFailures[0]).to.match(/timeout: no complete response within [0-9]+ms/)
    })
}

function hubConnectorDeadlineSuite() {
    afterEach(closeServers)
    registerDeadlineCases()
    registerBudgetCases()
}

describe('HubConnector: the call timeout is a total deadline', hubConnectorDeadlineSuite)
