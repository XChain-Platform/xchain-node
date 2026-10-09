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

const http = require('http')
const { spawn } = require('child_process')
const { expect } = require('./support/helpers')
const { healthcheckCommand } = require('../../../src/services/module_service/healthcheck_command')

function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => resolve(body))
        request.on('error', reject)
    })
}

function runCommand(command) {
    return new Promise(resolve => {
        const child = spawn('sh', ['-c', command])
        let stdout = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.on('close', code => resolve({ code, stdout }))
    })
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function close(server) {
    return new Promise(resolve => server.close(resolve))
}

describe('healthcheckCommand() failure output', function () {
    let server
    let requests
    let baseUrl

    beforeEach(async function () {
        requests = []
        server = http.createServer(async (request, response) => {
            requests.push({ method: request.method, body: await readBody(request) })
            response.writeHead(503, { 'Content-Type': 'application/json' })
            response.end('{"status":"degraded","reason":"oracle_stale"}')
        })
        await listen(server)
        baseUrl = `http://127.0.0.1:${server.address().port}`
    })

    afterEach(async function () {
        await close(server)
    })

    it('prints a failed GET response status and degraded reason', async function () {
        const command = healthcheckCommand({ url: `${baseUrl}/live`, timeoutSeconds: 5 })
        const result = await runCommand(command)
        expect(result.code).to.equal(1)
        expect(result.stdout).to.contain('HTTP 503')
        expect(result.stdout).to.contain('oracle_stale')
    })

    it('replays a failed JSON-RPC health POST for diagnostics', async function () {
        const postData = '{"jsonrpc":"2.0","method":"health","id":1}'
        const command = healthcheckCommand({ url: `${baseUrl}/`, postData, timeoutSeconds: 5 })
        const result = await runCommand(command)
        expect(result.code).to.equal(1)
        expect(result.stdout).to.contain('HTTP 503')
        expect(result.stdout).to.contain('oracle_stale')
        const posts = requests.filter(request => request.method === 'POST')
        expect(posts.length).to.be.greaterThan(0)
        expect(posts.every(request => JSON.parse(request.body).method === 'health')).to.be.true
    })

    it('prints an error line when the endpoint is unreachable', async function () {
        const port = server.address().port
        await close(server)
        server = http.createServer()
        const command = healthcheckCommand({ url: `http://127.0.0.1:${port}/`, timeoutSeconds: 1 })
        const result = await runCommand(command)
        expect(result.code).to.equal(1)
        expect(result.stdout).to.contain('health probe failed:')
    })

    it('keeps the wget timeout prefix and exact GET path', function () {
        const command = healthcheckCommand({ url: `${baseUrl}/live`, timeoutSeconds: 5 })
        expect(command).to.match(/^wget -T 5 /)
        expect(command).to.not.contain('/status')
    })
})
