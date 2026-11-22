'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { expect } = require('chai')

const CLI = path.join(__dirname, '../../../src/index.js')
const DECODER = 'xchain-decoder'
let ledgerDir, ledger, savedDir

function setup() {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-republish-clear-'))
    savedDir = process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
    process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = ledgerDir
    delete require.cache[require.resolve('../../../src/services/bootstrap_republish_ledger')]
    ledger = require('../../../src/services/bootstrap_republish_ledger')
}

function teardown() {
    if (savedDir === undefined) delete process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
    else process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = savedDir
    fs.rmSync(ledgerDir, { recursive: true, force: true })
}

function ledgerFile() {
    return path.join(ledgerDir, 'bootstrap-reindex.json')
}

function runClear(combo, at) {
    return spawnSync(process.execPath, [CLI, 'bootstrap-republish-clear', combo, '--at', at], {
        env: {
            ...process.env,
            XCHAIN_NODE_REINDEX_LEDGER_DIR: ledgerDir,
            XCHAIN_NODE_LOCK_DIR: ledgerDir,
            DOCKER_HOST: 'unix:///nonexistent/xchain-node-test-docker.sock'
        },
        encoding: 'utf8',
        timeout: 25000
    })
}

describe('bootstrap-republish-clear command', function () {
    beforeEach(setup)
    afterEach(teardown)

    it('clears after a publish attempt that started after the reindex', function () {
        ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z') })
        const result = runClear('xchain-decoder:bitcoin:testnet', '2026-09-01T01:00:00Z')
        expect(result.status, result.stderr).to.equal(0)
        expect(ledger.listRepublishDue()).to.deep.equal([])
    })

    it('stays due when a reset landed after the publish attempt started', function () {
        ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T02:00:00Z') })
        const result = runClear('xchain-decoder:bitcoin:testnet', '2026-09-01T01:00:00Z')
        expect(result.status, result.stderr).to.equal(0)
        expect(ledger.listRepublishDue().map(entry => entry.combo))
            .to.deep.equal(['xchain-decoder:bitcoin:testnet'])
    })

    it('rejects an invalid combo without changing the ledger', function () {
        ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z') })
        const before = fs.readFileSync(ledgerFile(), 'utf8')
        const result = runClear('not-a-combo', '2026-09-01T01:00:00Z')
        expect(result.status).to.equal(1)
        expect(fs.readFileSync(ledgerFile(), 'utf8')).to.equal(before)
    })

    it('rejects an invalid publish time without changing the ledger', function () {
        ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z') })
        const before = fs.readFileSync(ledgerFile(), 'utf8')
        const result = runClear('xchain-decoder:bitcoin:testnet', 'not-a-time')
        expect(result.status).to.equal(1)
        expect(fs.readFileSync(ledgerFile(), 'utf8')).to.equal(before)
    })

    it('rejects a damaged ledger without replacing its bytes', function () {
        fs.writeFileSync(ledgerFile(), '{"version":1,"combos":')
        const before = fs.readFileSync(ledgerFile(), 'utf8')
        const result = runClear('xchain-decoder:bitcoin:testnet', '2026-09-01T01:00:00Z')
        expect(result.status).to.equal(1)
        expect(fs.readFileSync(ledgerFile(), 'utf8')).to.equal(before)
    })
})
