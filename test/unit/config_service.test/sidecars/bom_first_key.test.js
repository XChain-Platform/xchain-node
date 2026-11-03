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
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const sidecars = require('../../../../src/services/config_service/sidecars')

const scratchRoot = path.resolve(__dirname, '../../../../tmp/bom-first-key')
const BOM = '﻿'

async function readLines(file) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    const lines = []
    for await (const line of rl) lines.push(line)
    return lines
}

function recognitionTests() {
    it('flags a BOM-prefixed NODE_USER in the main file as a credential', function () {
        const cfg = {}
        expect(sidecars.readMainConfigLine(cfg, BOM + 'NODE_USER=fake-user-1')).to.equal(true)
        expect(cfg.NODE_USER).to.equal('fake-user-1')
        expect(Object.keys(cfg).some((k) => k.includes(BOM))).to.equal(false)
    })

    it('reads a BOM-prefixed RPC_PORT under its clean key', function () {
        const cfg = {}
        sidecars.readMainConfigLine(cfg, BOM + 'RPC_PORT=18443')
        expect(cfg.RPC_PORT).to.equal('18443')
    })

    it('reads a BOM-prefixed sidecar line under a clean key', function () {
        const cfg = {}
        sidecars.readSidecarConfigLine(cfg, BOM + 'NODE_USER=u1')
        expect(cfg).to.deep.equal({ NODE_USER: 'u1' })
    })

    it('readSidecarValue finds a key on a BOM-prefixed first line', async function () {
        const f = path.join(fs.mkdtempSync(path.join(scratchRoot, 'sv-')), 'x.local')
        fs.writeFileSync(f, BOM + 'NODE_USER=u2\nOTHER=1\n')
        expect(await sidecars.readSidecarValue(f, 'NODE_USER')).to.equal('u2')
    })
}

function migrationTests() {
    it('migrates a BOM-prefixed NODE_USER out of the main file (CRLF, no trailing newline)', async function () {
        const dir = fs.mkdtempSync(path.join(scratchRoot, 'mig-'))
        const main = path.join(dir, 'bitcoin-regtest')
        fs.writeFileSync(main, BOM + 'NODE_USER=fake-user-1\r\nNODE_PASSWORD=fake-pw-1\r\nRPC_PORT=18443\r\n# c\r\nDUST_AMOUNT=546')
        const cfg = {}
        let has = false
        for (const line of await readLines(main)) has = sidecars.readMainConfigLine(cfg, line) || has
        expect(has).to.equal(true)
        expect(cfg.NODE_USER).to.equal('fake-user-1')
        sidecars.migrateMainCredentials(cfg, main, main + '.local')
        const disk = fs.readFileSync(main, 'utf8')
        expect(disk).to.not.include('NODE_USER')
        expect(disk).to.not.include('NODE_PASSWORD')
        expect(disk).to.include('RPC_PORT=18443')
        expect(fs.readFileSync(main + '.local', 'utf8')).to.include('NODE_USER=fake-user-1')
    })

    it('keeps a BOM-prefixed first non-credential key readable after migration', async function () {
        const dir = fs.mkdtempSync(path.join(scratchRoot, 'mig2-'))
        const main = path.join(dir, 'bitcoin-regtest')
        fs.writeFileSync(main, BOM + 'RPC_PORT=18443\nNODE_USER=u3\n')
        const cfg = {}
        for (const line of await readLines(main)) sidecars.readMainConfigLine(cfg, line)
        sidecars.migrateMainCredentials(cfg, main, main + '.local')
        const after = {}
        for (const line of await readLines(main)) sidecars.readMainConfigLine(after, line)
        expect(after.RPC_PORT).to.equal('18443')
    })
}

describe('a UTF-8 BOM on line 1 never changes how a config key is recognised', function () {
    before(function () {
        fs.mkdirSync(scratchRoot, { recursive: true })
        sidecars.configure({
            crypto, fs, path, readline, configDir: scratchRoot,
            preferredSecretEnvName: (k) => (k === 'NODE_PASSWORD' ? 'NODE_SECRET' : undefined),
            foldSecretEnvAliases: (c) => c,
            deprecatedSecretEnvNames: () => [],
            logger: { warn() {} }
        })
    })

    recognitionTests()
    migrationTests()
})
