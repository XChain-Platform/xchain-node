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

function configureSidecars(fsImpl) {
    sidecars.configure({
        crypto,
        fs: fsImpl,
        path,
        readline,
        configDir,
        preferredSecretEnvName,
        foldSecretEnvAliases,
        deprecatedSecretEnvNames: () => [],
        logger: { warn() {} }
    })
}

// Real fs with one method replaced, so a failure lands at an exact step of the write.
function fsWith(overrides) {
    return Object.assign(Object.create(fs), overrides)
}

function failingRename(match) {
    return fsWith({
        renameSync(from, to) {
            if (match(to)) throw Object.assign(new Error('rename failed'), { code: 'EIO' })
            return fs.renameSync(from, to)
        }
    })
}

function tempFilesIn(dir) {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
}

function tornWriteTests() {
    it('keeps the old sidecar byte for byte when the replacing rename fails', function () {
        const file = path.join(configDir, 'bitcoin-mainnet.local')
        const original = 'NODE_USER=alice\nNODE_SECRET=old-secret\n'
        fs.writeFileSync(file, original, { mode: 0o600 })
        configureSidecars(failingRename((to) => to === fs.realpathSync(file)))
        expect(() => sidecars.upsertSidecarValues(file, { DECODER_DB_PASS: 'new' })).to.throw('rename failed')
        expect(fs.readFileSync(file, 'utf8')).to.equal(original)
        expect(tempFilesIn(configDir)).to.deep.equal([])
    })

    it('keeps the old sidecar when the disk fills while writing the replacement', function () {
        const file = path.join(configDir, 'hub.local')
        const original = 'HUB_DB_PASS=old\n'
        fs.writeFileSync(file, original, { mode: 0o600 })
        configureSidecars(fsWith({
            writeFileSync(target, data, options) {
                if (String(target).endsWith('.tmp')) {
                    fs.writeFileSync(target, String(data).slice(0, 3), options)
                    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
                }
                return fs.writeFileSync(target, data, options)
            }
        }))
        expect(() => sidecars.upsertSidecarValues(file, { HUB_API_KEY: 'k' })).to.throw('no space left')
        expect(fs.readFileSync(file, 'utf8')).to.equal(original)
        expect(tempFilesIn(configDir)).to.deep.equal([])
    })

    it('keeps the old sidecar when adding a missing credential fails mid-write', function () {
        const file = path.join(configDir, 'bitcoin-regtest.local')
        const original = 'NODE_USER=existing-user\n'
        fs.writeFileSync(file, original, { mode: 0o600 })
        configureSidecars(failingRename(() => true))
        expect(() => sidecars.generateRpcCredentials({ NODE_USER: 'existing-user' }, file)).to.throw('rename failed')
        expect(fs.readFileSync(file, 'utf8')).to.equal(original)
        expect(tempFilesIn(configDir)).to.deep.equal([])
    })
}

function replacedFileShapeTests() {
    it('leaves a replaced sidecar at 0600 with no temp file beside it', function () {
        const file = path.join(configDir, 'bitcoin-mainnet.local')
        fs.writeFileSync(file, 'NODE_USER=alice\n', { mode: 0o644 })
        sidecars.upsertSidecarValues(file, { INDEXER_DB_PASS: 'p' })
        expect(fs.readFileSync(file, 'utf8')).to.equal('NODE_USER=alice\nINDEXER_DB_PASS=p\n')
        expect(fs.statSync(file).mode & 0o777).to.equal(0o600)
        expect(fs.readdirSync(configDir)).to.deep.equal(['bitcoin-mainnet.local'])
    })

    it('rewrites the file a symlinked sidecar points at and keeps the link', function () {
        const real = path.join(configDir, 'real.local')
        const link = path.join(configDir, 'bitcoin-mainnet.local')
        fs.writeFileSync(real, 'NODE_USER=alice\n', { mode: 0o600 })
        fs.symlinkSync(real, link)
        sidecars.upsertSidecarValues(link, { DECODER_DB_PASS: 'd' })
        expect(fs.lstatSync(link).isSymbolicLink()).to.equal(true)
        expect(fs.readFileSync(real, 'utf8')).to.equal('NODE_USER=alice\nDECODER_DB_PASS=d\n')
    })
}

function migrationTornWriteTests() {
    it('keeps the old main config when its rewrite fails during credential migration', function () {
        const configFile = path.join(configDir, 'bitcoin-mainnet')
        const sidecarFile = configFile + '.local'
        const original = 'DUST_AMOUNT=546\nNODE_USER=alice\nNODE_PASSWORD=secret\n'
        fs.writeFileSync(configFile, original, { mode: 0o640 })
        configureSidecars(failingRename((to) => to === fs.realpathSync(configFile)))
        const defaults = { DUST_AMOUNT: '546', NODE_USER: 'alice', NODE_PASSWORD: 'secret' }
        expect(() => sidecars.migrateMainCredentials(defaults, configFile, sidecarFile)).to.throw('rename failed')
        expect(fs.readFileSync(configFile, 'utf8')).to.equal(original)
        expect(tempFilesIn(configDir)).to.deep.equal([])
    })

    it('keeps the main config permissions across a credential migration', function () {
        const configFile = path.join(configDir, 'bitcoin-mainnet')
        fs.writeFileSync(configFile, 'DUST_AMOUNT=546\nNODE_USER=alice\nNODE_PASSWORD=secret\n')
        fs.chmodSync(configFile, 0o640)
        const defaults = { DUST_AMOUNT: '546', NODE_USER: 'alice', NODE_PASSWORD: 'secret' }
        sidecars.migrateMainCredentials(defaults, configFile, configFile + '.local')
        expect(fs.readFileSync(configFile, 'utf8')).to.equal('DUST_AMOUNT=546\n')
        expect(fs.statSync(configFile).mode & 0o777).to.equal(0o640)
        expect(fs.readFileSync(configFile + '.local', 'utf8')).to.equal('NODE_USER=alice\nNODE_PASSWORD=secret\n')
    })
}

describe('config_service/sidecars', function () {
    beforeEach(function () {
        fs.mkdirSync(scratchRoot, { recursive: true })
        configDir = fs.mkdtempSync(path.join(scratchRoot, 'case-'))
        configureSidecars(fs)
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

describe('config_service/sidecars crash-safe writes', function () {
    beforeEach(function () {
        fs.mkdirSync(scratchRoot, { recursive: true })
        configDir = fs.mkdtempSync(path.join(scratchRoot, 'case-'))
        configureSidecars(fs)
    })

    afterEach(function () {
        configureSidecars(fs)
        fs.rmSync(configDir, { recursive: true, force: true })
    })

    after(function () {
        fs.rmSync(scratchRoot, { recursive: true, force: true })
    })

    tornWriteTests()
    replacedFileShapeTests()
    migrationTornWriteTests()
})
