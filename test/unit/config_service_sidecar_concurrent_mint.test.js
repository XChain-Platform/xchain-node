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

// Several config loaders can reach a coin's sidecar before any of them has written
// RPC credentials to it (a read-only command probing services while a mutating one
// deploys). If each one minted its own NODE_USER/NODE_PASSWORD and kept it in
// memory while only the last writer's landed on disk, a container could be
// deployed with a password no later load would ever read back. Every loader must
// end with the one credential the sidecar holds.

const { expect } = require('chai')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const sidecars = require('../../src/services/config_service/sidecars')
const secretEnv = require('../../src/config/secret_env')
const sidecarLock = require('../../src/services/config_service/sidecar_lock')

const SIDECARS_PATH = require.resolve('../../src/services/config_service/sidecars')
const SECRET_ENV_PATH = require.resolve('../../src/config/secret_env')

let configDir

function configureSidecars(dir) {
    sidecars.configure({
        crypto, fs, path, readline, configDir: dir,
        preferredSecretEnvName: secretEnv.preferredSecretEnvName,
        foldSecretEnvAliases: secretEnv.foldSecretEnvAliases,
        deprecatedSecretEnvNames: secretEnv.deprecatedSecretEnvNames,
        logger: { warn() {}, info() {}, error() {}, debug() {} }
    })
}

// What the loader holds once both files are read: the main file, then the sidecar
// merged over it, exactly as getDefaultConfig builds it before minting.
function loadedConfig(mainBody, sidecarBody, configFile, sidecarFile) {
    const cfg = {}
    for (const line of mainBody.split(/\r?\n/)) sidecars.readMainConfigLine(cfg, line)
    sidecars.normalizeMainConfig(cfg, configFile)
    if (sidecarBody !== undefined) {
        const side = {}
        for (const line of sidecarBody.split(/\r?\n/)) sidecars.readSidecarConfigLine(side, line)
        sidecars.mergeSidecarConfig(cfg, side, sidecarFile)
    }
    return cfg
}

function readDisk(sidecarFile) {
    const side = {}
    for (const line of fs.readFileSync(sidecarFile, 'utf8').split(/\r?\n/)) sidecars.readSidecarConfigLine(side, line)
    return secretEnv.foldSecretEnvAliases(side)
}

function countLines(sidecarFile, key) {
    return fs.readFileSync(sidecarFile, 'utf8').split(/\r?\n/).filter(l => l.startsWith(key + '=')).length
}

// Each child runs the loader's sidecar sequence once the start file appears and
// prints a hash of the password it ended with, never the password itself.
const childCode = `
    const crypto = require('crypto'), fs = require('fs'), path = require('path'), readline = require('readline')
    const s = require(${JSON.stringify(SIDECARS_PATH)}), e = require(${JSON.stringify(SECRET_ENV_PATH)})
    const [configFile, sidecarFile, startFile] = process.argv.slice(1)
    s.configure({ crypto, fs, path, readline, configDir: path.dirname(configFile),
        preferredSecretEnvName: e.preferredSecretEnvName, foldSecretEnvAliases: e.foldSecretEnvAliases,
        deprecatedSecretEnvNames: e.deprecatedSecretEnvNames, logger: { warn() {} } })
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(startFile)) Atomics.wait(sleeper, 0, 0, 2)
    const cfg = {}
    let armed = false
    for (const l of fs.readFileSync(configFile, 'utf8').split(/\\r?\\n/)) armed = s.readMainConfigLine(cfg, l) || armed
    s.normalizeMainConfig(cfg, configFile)
    if (fs.existsSync(sidecarFile)) {
        const side = {}
        for (const l of fs.readFileSync(sidecarFile, 'utf8').split(/\\r?\\n/)) s.readSidecarConfigLine(side, l)
        s.mergeSidecarConfig(cfg, side, sidecarFile)
    }
    if (armed) s.migrateMainCredentials(cfg, configFile, sidecarFile)
    s.generateRpcCredentials(cfg, sidecarFile)
    process.stdout.write(crypto.createHash('sha256').update(String(cfg.NODE_PASSWORD)).digest('hex'))
`

function runLoaderChild(configFile, sidecarFile, startFile) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', childCode, configFile, sidecarFile, startFile],
            { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', d => { out += d })
        child.stderr.on('data', d => { err += d })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('child exit ' + code + ': ' + err)))
    })
}

function interleaveTests() {
    it('every loader that read an empty sidecar ends with the credential on disk', function () {
        const configFile = path.join(configDir, 'bitcoin-regtest')
        const sidecarFile = configFile + '.local'
        fs.writeFileSync(configFile, 'RPC_PORT=18443\n')
        // All four read before any of them wrote: the lost-update interleave.
        const loaders = [0, 1, 2, 3].map(() => loadedConfig('RPC_PORT=18443\n', undefined, configFile, sidecarFile))
        for (const cfg of loaders) sidecars.generateRpcCredentials(cfg, sidecarFile)

        const disk = readDisk(sidecarFile)
        expect(disk.NODE_USER).to.match(/^[0-9a-f]{24}$/)
        expect(disk.NODE_PASSWORD).to.match(/^[0-9a-f]{48}$/)
        for (const cfg of loaders) {
            expect(cfg.NODE_USER).to.equal(disk.NODE_USER)
            expect(cfg.NODE_PASSWORD).to.equal(disk.NODE_PASSWORD)
        }
        expect(countLines(sidecarFile, 'NODE_SECRET')).to.equal(1)
        expect(countLines(sidecarFile, 'NODE_USER')).to.equal(1)
        expect(fs.statSync(sidecarFile).mode & 0o777).to.equal(0o600)
    })

    it('a partial sidecar keeps its user and every loader adopts the one minted password', function () {
        const configFile = path.join(configDir, 'bitcoin-regtest')
        const sidecarFile = configFile + '.local'
        fs.writeFileSync(configFile, 'RPC_PORT=18443\n')
        fs.writeFileSync(sidecarFile, 'NODE_USER=part-user\n', { mode: 0o600 })
        const loaders = [0, 1, 2, 3].map(() =>
            loadedConfig('RPC_PORT=18443\n', 'NODE_USER=part-user\n', configFile, sidecarFile))
        for (const cfg of loaders) sidecars.generateRpcCredentials(cfg, sidecarFile)

        const disk = readDisk(sidecarFile)
        expect(disk.NODE_USER).to.equal('part-user')
        for (const cfg of loaders) {
            expect(cfg.NODE_USER).to.equal('part-user')
            expect(cfg.NODE_PASSWORD).to.equal(disk.NODE_PASSWORD)
        }
        expect(countLines(sidecarFile, 'NODE_SECRET')).to.equal(1)
    })

    it('a value another loader wrote under the legacy name is adopted, not re-minted', function () {
        const sidecarFile = path.join(configDir, 'bitcoin-regtest.local')
        const cfg = {}
        // Written after this loader read the sidecar, by an older writer that used the legacy name.
        fs.writeFileSync(sidecarFile, 'NODE_USER=other-user\nNODE_PASSWORD=other-pass\n', { mode: 0o600 })
        sidecars.generateRpcCredentials(cfg, sidecarFile)
        expect(cfg).to.include({ NODE_USER: 'other-user', NODE_PASSWORD: 'other-pass' })
        expect(fs.readFileSync(sidecarFile, 'utf8')).to.equal('NODE_USER=other-user\nNODE_PASSWORD=other-pass\n')
    })

    it('concurrent upserts of different keys never drop each other', function () {
        const sidecarFile = path.join(configDir, 'bitcoin-regtest.local')
        sidecars.generateRpcCredentials({}, sidecarFile)
        sidecars.upsertSidecarValues(sidecarFile, { DECODER_DB_PASS: 'd' })
        const disk = readDisk(sidecarFile)
        expect(disk.NODE_USER).to.be.a('string').and.not.equal('')
        expect(disk.NODE_PASSWORD).to.be.a('string').and.not.equal('')
        expect(disk.DECODER_DB_PASS).to.equal('d')
        expect(fs.existsSync(sidecarFile + '.lock')).to.equal(false)
    })
}

function processRaceTests() {
    it('four processes released together all end with the sidecar credential', async function () {
        this.timeout(20000)
        const configFile = path.join(configDir, 'bitcoin-regtest')
        const sidecarFile = configFile + '.local'
        const startFile = path.join(configDir, 'start')
        fs.writeFileSync(configFile, 'RPC_PORT=18443\n')

        const runs = [0, 1, 2, 3].map(() => runLoaderChild(configFile, sidecarFile, startFile))
        await new Promise(r => setTimeout(r, 300))
        fs.writeFileSync(startFile, '')
        const hashes = await Promise.all(runs)

        const diskHash = crypto.createHash('sha256').update(readDisk(sidecarFile).NODE_PASSWORD).digest('hex')
        expect(hashes).to.deep.equal([diskHash, diskHash, diskHash, diskHash])
        expect(countLines(sidecarFile, 'NODE_SECRET')).to.equal(1)
    })
}

function lockRecoveryTests() {
    it('breaks a lock whose recorded pid no longer exists and still persists one credential', function () {
        const sidecarFile = path.join(configDir, 'bitcoin-regtest.local')
        // Far above any pid the kernel hands out, so the holder is certainly gone.
        fs.writeFileSync(sidecarFile + '.lock', '2147483646', { mode: 0o600 })
        const cfg = {}
        sidecars.generateRpcCredentials(cfg, sidecarFile)
        expect(readDisk(sidecarFile).NODE_PASSWORD).to.equal(cfg.NODE_PASSWORD)
        expect(fs.readdirSync(configDir).filter(n => n.includes('.lock'))).to.deep.equal([])
    })

    it('never removes a lock that another holder now owns', function () {
        const sidecarFile = path.join(configDir, 'bitcoin-regtest.local')
        const lockFile = sidecarFile + '.lock'
        const otherPid = String(process.ppid)
        // A later holder takes the name while this one is still inside the section.
        sidecarLock.withSidecarLock(sidecarFile, () => fs.writeFileSync(lockFile, otherPid))
        expect(fs.readFileSync(lockFile, 'utf8')).to.equal(otherPid)
    })
}

describe('config_service sidecar: concurrent first-time RPC credential mint', function () {
    beforeEach(function () {
        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-sidecar-mint-'))
        configureSidecars(configDir)
    })

    afterEach(function () {
        fs.rmSync(configDir, { recursive: true, force: true })
    })

    describe('loaders that all read before any wrote', interleaveTests)
    describe('separate processes released together', processRaceTests)
    describe('a lock left behind by a crashed writer', lockRecoveryTests)
})
