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
const sidecars = require('../../../src/services/config_service/sidecars')

const scratchRoot = path.resolve(__dirname, '../../../tmp/glued-credential-peel-boundary')

// Reads a main config the way configure() does, then migrates when a credential was found.
function load(text, name) {
    const main = path.join(fs.mkdtempSync(path.join(scratchRoot, name + '-')), 'bitcoin-regtest')
    fs.writeFileSync(main, text)
    const cfg = {}
    let hasCreds = false
    for (const line of text.split(/\r?\n/)) hasCreds = sidecars.readMainConfigLine(cfg, line) || hasCreds
    if (hasCreds) sidecars.migrateMainCredentials(cfg, main, main + '.local')
    return { cfg, hasCreds, disk: fs.readFileSync(main, 'utf8'), sidecar: fs.existsSync(main + '.local') ? fs.readFileSync(main + '.local', 'utf8') : null }
}

describe('glued credential peel key boundary', function () {
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

    it('leaves a value that only ends in another key name alone', function () {
        const text = 'RPC_PORT=18443\nDUST_AMOUNT=546\nEXTRA_ENV=FOO_NODE_USER=bob\n'
        const r = load(text, 'a')
        expect(r.hasCreds).to.equal(false)
        expect(r.cfg.EXTRA_ENV).to.equal('FOO_NODE_USER=bob')
        expect(r.cfg.NODE_USER).to.equal(undefined)
        expect(r.disk).to.equal(text)
    })

    it('does not read a credential out of a comment', function () {
        const text = 'RPC_PORT=18443\n# example: FOO=bar NODE_PASSWORD=example-pw\n'
        const r = load(text, 'b')
        expect(r.hasCreds).to.equal(false)
        expect(r.cfg.NODE_PASSWORD).to.equal(undefined)
        expect(r.disk).to.equal(text)
        expect(r.sidecar).to.equal(null)
    })

    it('keeps a comment unchanged when a real credential is migrated', function () {
        const r = load('# note NODE_USER=x\nNODE_USER=real\nNODE_PASSWORD=pw\n', 'c')
        expect(r.disk).to.equal('# note NODE_USER=x\n')
        expect(r.cfg.NODE_USER).to.equal('real')
    })

    it('still peels a genuinely glued line, user after password', function () {
        const r = load('DUST_AMOUNT=546NODE_PASSWORD=pw1NODE_USER=u1\n', 'd')
        expect(r.cfg.NODE_PASSWORD).to.equal('pw1')
        expect(r.cfg.NODE_USER).to.equal('u1')
        expect(r.cfg.DUST_AMOUNT).to.equal('546')
        expect(r.disk).to.equal('DUST_AMOUNT=546\n')
    })

    it('still peels a genuinely glued line, user before password', function () {
        const r = load('DUST_AMOUNT=546NODE_USER=u1NODE_PASSWORD=pw1\n', 'e')
        expect(r.cfg.NODE_PASSWORD).to.equal('pw1')
        expect(r.cfg.NODE_USER).to.equal('u1')
        expect(r.disk).to.equal('DUST_AMOUNT=546\n')
    })
})
