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


const { configStub, expect, proxyquire, path } = require('./helpers.test')

const crypto = require('crypto')

const realFs = require('fs')

const os     = require('os')

let dir

function serviceWithConfigDir(d) {
    return proxyquire('../../../src/services/config_service', {
        '../config': configStub({ ...require('../../../src/config'), configDir: d })
    })
}

function sidecarPath() { return path.join(dir, 'hub.local') }

function readKeyShape() {
    const line = realFs.readFileSync(sidecarPath(), 'utf8')
        .split(/\r?\n/).find(l => l.startsWith('HUB_API_KEY='))
    if (!line) return null
    const value = line.slice('HUB_API_KEY='.length)
    return { length: value.length, hex: /^[0-9a-f]+$/.test(value) }
}

// Identity of the file's CONTENT without holding the content: proof that a second
// run left the credential untouched, printable in a failure message.
function sidecarDigest() {
    return crypto.createHash('sha256').update(realFs.readFileSync(sidecarPath())).digest('hex')
}

// The credential `validator init` mints so the hub can boot at all. Driven against a
// REAL temp directory: the whole value of this function is the file it leaves behind -
// its mode, its other keys, its stability across runs - and a stubbed fs shows none of
// that. Every assertion here is on SHAPE read back out of the file; the generated value
// is never returned by the code and is never rendered by a test, so a failing assertion
// cannot print a live credential.
function ensureHubApiKey1() {
    beforeEach(function () { dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'xchain-hub-api-key-')) })

    afterEach(function () { realFs.rmSync(dir, { recursive: true, force: true }) })

    it('generates a key into the shared hub sidecar on a host that has none', async function () {
        const cs = serviceWithConfigDir(dir)
        const result = await cs.ensureHubApiKey()
        expect(result.generated).to.be.true
        expect(result.path).to.equal(sidecarPath())
        expect(readKeyShape()).to.deep.equal({ length: 64, hex: true })
    })

    it('locks the sidecar to 0600, so no other local user can read the credential', async function () {
        const cs = serviceWithConfigDir(dir)
        await cs.ensureHubApiKey()
        expect(realFs.statSync(sidecarPath()).mode & 0o777).to.equal(0o600)
    })

    // The strongest no-leak guarantee available: a value the function does not hand
    // back cannot be logged, echoed into a report, or asserted on by mistake.
    it('never returns the key itself, only where it lives', async function () {
        const cs = serviceWithConfigDir(dir)
        const result = await cs.ensureHubApiKey()
        expect(Object.keys(result).sort()).to.deep.equal(['generated', 'path'])
        expect(JSON.stringify(result)).to.not.match(/[0-9a-f]{64}/)
    })

    // Rotating on a re-run would 401 every indexer and explorer already configured
    // with the old key, which is a worse outage than the one this closes.
    it('reuses an existing key and leaves the file byte-identical', async function () {
        const cs = serviceWithConfigDir(dir)
        await cs.ensureHubApiKey()
        const before = sidecarDigest()
        const second = await cs.ensureHubApiKey()
        expect(second.generated).to.be.false
        expect(second.path).to.equal(sidecarPath())
        expect(sidecarDigest()).to.equal(before)
    })

    it('adopts a key the operator wrote by hand rather than replacing it', async function () {
        realFs.writeFileSync(sidecarPath(), 'HUB_API_KEY=operator-written-fixture\n', { mode: 0o600 })
        const before = sidecarDigest()
        const cs = serviceWithConfigDir(dir)
        const result = await cs.ensureHubApiKey()
        expect(result.generated).to.be.false
        expect(sidecarDigest()).to.equal(before)
    })
}

function ensureHubApiKey2() {
    beforeEach(function () { dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'xchain-hub-api-key-')) })

    afterEach(function () { realFs.rmSync(dir, { recursive: true, force: true }) })

    // The same file already carries HUB_DB_PASS. Clobbering it would take the hub's
    // database down as the price of giving it an API key.
    it('preserves the other credentials already in the sidecar', async function () {
        realFs.writeFileSync(sidecarPath(), 'HUB_DB_PASS=db-fixture-value\n', { mode: 0o600 })
        const cs = serviceWithConfigDir(dir)
        await cs.ensureHubApiKey()
        const body = realFs.readFileSync(sidecarPath(), 'utf8')
        expect(body).to.include('HUB_DB_PASS=db-fixture-value')
        expect(readKeyShape()).to.deep.equal({ length: 64, hex: true })
    })

    it('creates the config directory when it does not exist yet', async function () {
        const nested = path.join(dir, 'not-created-yet')
        const cs = serviceWithConfigDir(nested)
        const result = await cs.ensureHubApiKey()
        expect(result.generated).to.be.true
        expect(realFs.existsSync(path.join(nested, 'hub.local'))).to.be.true
    })
}

// The non-minting read. A key APPEARING on a keyless host 401s every consumer that
// carries none, so callers that only need to report where the credential lives must
// have a way to ask that cannot create one.
function readHubApiKey() {
    it('reports absence and writes NOTHING on a keyless host', async function () {
        const cs = serviceWithConfigDir(dir)
        const result = await cs.readHubApiKey()
        expect(result.present).to.be.false
        expect(result.path).to.equal(sidecarPath())
        expect(realFs.existsSync(sidecarPath())).to.be.false
    })

    it('leaves a sidecar that holds other credentials byte-identical', async function () {
        realFs.writeFileSync(sidecarPath(), 'HUB_DB_PASS=db-fixture-value\n', { mode: 0o600 })
        const before = sidecarDigest()
        const cs = serviceWithConfigDir(dir)
        expect((await cs.readHubApiKey()).present).to.be.false
        expect(sidecarDigest()).to.equal(before)
    })

    it('reports a present key without rotating it', async function () {
        const cs = serviceWithConfigDir(dir)
        await cs.ensureHubApiKey()
        const before = sidecarDigest()
        const result = await cs.readHubApiKey()
        expect(result.present).to.be.true
        expect(sidecarDigest()).to.equal(before)
    })

    it('never returns the key itself, only whether there is one', async function () {
        const cs = serviceWithConfigDir(dir)
        await cs.ensureHubApiKey()
        const result = await cs.readHubApiKey()
        expect(Object.keys(result).sort()).to.deep.equal(['path', 'present'])
        expect(JSON.stringify(result)).to.not.match(/[0-9a-f]{64}/)
    })

}

function ensureReadHubApiKey() {
    beforeEach(function () { dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'xchain-hub-api-key-')) })

    afterEach(function () { realFs.rmSync(dir, { recursive: true, force: true }) })

    describe('readHubApiKey()', readHubApiKey)
}

describe('ConfigService', function () {
    describe('ensureHubApiKey()', ensureHubApiKey1)
})

describe('ConfigService', function () {
    describe('ensureHubApiKey()', ensureHubApiKey2)
})

describe('ConfigService', function () {
    describe('ensureHubApiKey()', ensureReadHubApiKey)
})
