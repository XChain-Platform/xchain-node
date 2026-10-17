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
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const sidecars = require('../../../src/services/config_service/sidecars')

const scratchRoot = path.resolve(__dirname, '../../../tmp/config-service-sidecars-module')
let configDir

function preferredSecretEnvName(key) {
    return key === 'NODE_PASSWORD' ? 'NODE_SECRET'
        : key === 'HUB_API_KEY' ? 'HUB_API_SECRET'
            : undefined
}

function foldSecretEnvAliases(config) {
    if (config.NODE_SECRET) config.NODE_PASSWORD = config.NODE_SECRET
    if (config.HUB_API_SECRET) config.HUB_API_KEY = config.HUB_API_SECRET
    return config
}

function persistenceTests() {
    it('creates and appends sidecar credentials with mode 0600 and valid line boundaries', function () {
        const file = path.join(configDir, 'bitcoin-mainnet.local')
        sidecars.persistSidecarCreds(file, { NODE_USER: 'alice' })
        fs.appendFileSync(file, 'EXTRA=value')
        sidecars.persistSidecarCreds(file, { NODE_PASSWORD: 'secret' })
        expect(fs.readFileSync(file, 'utf8')).to.equal(
            'NODE_USER=alice\nEXTRA=value\nNODE_PASSWORD=secret\n')
        expect(fs.statSync(file).mode & 0o777).to.equal(0o600)
    })

    it('upserts values without discarding existing keys and prefers safe secret names', function () {
        const file = path.join(configDir, 'bitcoin-mainnet.local')
        fs.writeFileSync(file, 'NODE_USER=alice\nKEEP=value\n')
        sidecars.upsertSidecarValues(file, { NODE_PASSWORD: 'new-secret' })
        expect(fs.readFileSync(file, 'utf8')).to.equal(
            'NODE_USER=alice\nKEEP=value\nNODE_SECRET=new-secret\n')
    })

    it('reads a safe secret alias in preference to the legacy name', async function () {
        const file = path.join(configDir, 'hub.local')
        fs.writeFileSync(file, 'HUB_API_KEY=legacy\nHUB_API_SECRET=preferred\n')
        expect(await sidecars.readSidecarValue(file, 'HUB_API_KEY')).to.equal('preferred')
    })
}

function hubKeyTests() {
    it('generates a hub API key once and then reuses it', async function () {
        const first = await sidecars.ensureHubApiKey()
        const contents = fs.readFileSync(first.path, 'utf8')
        const second = await sidecars.ensureHubApiKey()
        expect(first.generated).to.equal(true)
        expect(second).to.deep.equal({ path: first.path, generated: false })
        expect(fs.readFileSync(first.path, 'utf8')).to.equal(contents)
        expect(contents).to.match(/^HUB_API_SECRET=[0-9a-f]{64}\n$/)
    })

    it('applies a hub sidecar key only when the target has no key', async function () {
        fs.writeFileSync(path.join(configDir, 'hub.local'), 'HUB_API_SECRET=sidecar-key\n')
        const empty = {}
        const explicit = { HUB_API_KEY: 'host-key' }
        await sidecars.applyHubApiKeyFromSidecar(empty)
        await sidecars.applyHubApiKeyFromSidecar(explicit)
        expect(empty.HUB_API_KEY).to.equal('sidecar-key')
        expect(explicit.HUB_API_KEY).to.equal('host-key')
    })
}

function parsingAndGenerationTests() {
    it('rejects coin names that escape the config directory', function () {
        expect(() => sidecars.coinConfigPaths('../outside', '')).to.throw('Config path traversal detected')
    })

    it('recovers credentials glued to the end of a main-config value', function () {
        const defaults = {}
        const found = sidecars.readMainConfigLine(
            defaults,
            'DUST_AMOUNT=546NODE_USER=aliceNODE_PASSWORD=secret')
        expect(found).to.equal(true)
        expect(defaults).to.deep.equal({
            DUST_AMOUNT: '546',
            NODE_USER: 'alice',
            NODE_PASSWORD: 'secret'
        })
    })

    it('generates only a missing RPC credential and persists its safe alias', function () {
        const file = path.join(configDir, 'bitcoin-regtest.local')
        const defaults = { NODE_USER: 'existing-user' }
        sidecars.generateRpcCredentials(defaults, file)
        expect(defaults.NODE_USER).to.equal('existing-user')
        expect(defaults.NODE_PASSWORD).to.match(/^[0-9a-f]{48}$/)
        expect(fs.readFileSync(file, 'utf8')).to.equal('NODE_SECRET=' + defaults.NODE_PASSWORD + '\n')
    })
}

describe('config_service/sidecars', function () {
    beforeEach(function () {
        fs.mkdirSync(scratchRoot, { recursive: true })
        configDir = fs.mkdtempSync(path.join(scratchRoot, 'case-'))
        sidecars.configure({
            crypto,
            fs,
            path,
            readline,
            configDir,
            preferredSecretEnvName,
            foldSecretEnvAliases,
            deprecatedSecretEnvNames: () => [],
            logger: { warn() {} }
        })
    })

    afterEach(function () {
        fs.rmSync(configDir, { recursive: true, force: true })
    })

    after(function () {
        fs.rmSync(scratchRoot, { recursive: true, force: true })
    })

    persistenceTests()
    hubKeyTests()
    parsingAndGenerationTests()
})
