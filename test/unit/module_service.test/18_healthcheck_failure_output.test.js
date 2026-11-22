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

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { expect, makeStubs, loadModuleService } = require('./support/helpers')
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

function runCommand(command, env) {
    return new Promise(resolve => {
        const child = spawn('sh', ['-c', command], env ? { env } : undefined)
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

// A stand-in wget in a temp directory records the arguments it receives, so the test sees
// exactly what the container's shell handed the real one. It exits as told by WGET_EXIT.
function installFakeWget() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-fake-wget-'))
    const argsFile = path.join(dir, 'args')
    fs.writeFileSync(path.join(dir, 'wget'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_WGET_ARGS"\nexit "${WGET_EXIT:-0}"\n', { mode: 0o755 })
    const probeEnv = extra => ({ PATH: dir + path.delimiter + process.env.PATH, FAKE_WGET_ARGS: argsFile, ...extra })
    const received = () => fs.readFileSync(argsFile, 'utf8').split('\n')
    return { dir, probeEnv, received }
}

describe('healthcheckCommand() API key', function () {
    let fake
    beforeEach(function () { fake = installFakeWget() })
    afterEach(function () { fs.rmSync(fake.dir, { recursive: true, force: true }) })

    const KEY = 'k e"y$x'
    const probe = () => healthcheckCommand({ url: 'http://localhost:3001/status', timeoutSeconds: 5, authEnv: 'API_KEY' })

    it('hands wget the container\'s key as one x-api-key header', async function () {
        const result = await runCommand(probe(), fake.probeEnv({ API_KEY: KEY }))
        expect(result.code).to.equal(0)
        expect(fake.received()).to.include('--header=x-api-key: ' + KEY)
        expect(fake.received()).to.include('http://localhost:3001/status')
    })

    it('sends no key header when the container has none', async function () {
        const result = await runCommand(probe(), fake.probeEnv({}))
        expect(result.code).to.equal(0)
        expect(fake.received().filter(a => a.includes('x-api-key'))).to.deep.equal([])
    })

    it('keeps the key out of the command text', function () {
        expect(probe()).to.not.contain(KEY)
        expect(probe()).to.contain('${API_KEY:+--header=')
    })

    it('sends the key from the node fallback too, so a failed probe is diagnosed with the same request', async function () {
        const seen = []
        const server = http.createServer((request, response) => {
            seen.push(request.headers['x-api-key'])
            response.writeHead(request.headers['x-api-key'] === 'sekret' ? 503 : 401)
            response.end('{"status":"degraded"}')
        })
        await listen(server)
        try {
            const url = `http://127.0.0.1:${server.address().port}/status`
            const command = healthcheckCommand({ url, timeoutSeconds: 5, authEnv: 'API_KEY' })
            const result = await runCommand(command, fake.probeEnv({ API_KEY: 'sekret', WGET_EXIT: '1' }))
            expect(result.code).to.equal(1)
            expect(seen).to.deep.equal(['sekret'])
            expect(result.stdout).to.contain('HTTP 503')
        } finally {
            await close(server)
        }
    })

})

describe('healthcheckCommand() API key option and descriptor', function () {
    it('adds nothing for a descriptor with no authEnv', function () {
        const command = healthcheckCommand({ url: 'http://localhost:3001/status', timeoutSeconds: 5 })
        expect(command).to.not.contain('x-api-key')
    })

    it('refuses an auth env name that is not a plain variable name', function () {
        for (const authEnv of ['api_key', 'API KEY', 'A;rm', '$API_KEY', '']) {
            expect(() => healthcheckCommand({ url: 'http://localhost:3001/', timeoutSeconds: 5, authEnv }), authEnv).to.throw(/invalid healthcheck auth env name/)
        }
    })

    it('is requested by the encoder descriptor and by no keyless service', function () {
        const ms = loadModuleService(makeStubs())
        const cmd = (module, env) => {
            const args = ms.buildHealthcheckArgs(module, env)
            return args[args.indexOf('--health-cmd') + 1]
        }
        expect(cmd('xchain-encoder', { ENCODER_API_PORT: '3001' })).to.contain('${API_KEY:+--header="x-api-key: $API_KEY"}')
        expect(cmd('xchain-decoder', { DECODER_API_PORT: '3002' })).to.not.contain('x-api-key')
        expect(cmd('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })).to.not.contain('x-api-key')
    })
})
