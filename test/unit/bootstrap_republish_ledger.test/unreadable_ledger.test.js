'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A republish ledger that exists but cannot be read is not a box that never
// reindexed. Each shape below once read as "nothing due" with no warning, the
// bootstrap-republish-due command printed an empty list and exited 0, and a
// publish against the truncated file reported success without touching it, so
// the forced republish after a reindex failed open.

const fs          = require('fs')
const os          = require('os')
const path        = require('path')
const { spawnSync } = require('child_process')
const { expect }  = require('chai')

const { XChainService } = require('../../../src/config')

const DECODER = XChainService.XCHAIN_DECODER
const CLI     = path.join(__dirname, '../../../src/index.js')

let ledgerDir, lockDir, ledger, savedDir, savedWarn, warnings

function setup() {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-republish-unreadable-'))
    lockDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-republish-unreadable-lock-'))
    savedDir  = process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
    process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = ledgerDir
    delete require.cache[require.resolve('../../../src/services/bootstrap_republish_ledger')]
    ledger    = require('../../../src/services/bootstrap_republish_ledger')
    // The logger resolves console.warn per call, so this stub sees its output.
    warnings  = []
    savedWarn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
}

function teardown() {
    console.warn = savedWarn
    try { fs.chmodSync(ledgerFile(), 0o600) } catch { /* not a mode-000 case */ }
    if (savedDir === undefined) delete process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
    else process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = savedDir
    fs.rmSync(ledgerDir, { recursive: true, force: true })
    fs.rmSync(lockDir, { recursive: true, force: true })
}

function ledgerFile() {
    return path.join(ledgerDir, 'bootstrap-reindex.json')
}

// The first 300 bytes of a valid ledger holding three due combos, one of them
// a decoder whose reindex is newer than its last publish.
function writeTruncatedDueLedger() {
    const due = { reindexedAt: '2026-11-02T10:00:00.000Z', publishedAt: null, reason: 'reset all' }
    const doc = {
        version: 1,
        combos: {
            'xchain-decoder:bitcoin:regtest':       { ...due, publishedAt: '2026-11-01T10:00:00.000Z' },
            'xchain-indexer:dogecoin:regtest':      due,
            'xchain-utxo-tracker:litecoin:regtest': due
        }
    }
    const full = JSON.stringify(doc, null, 2) + '\n'
    expect(full.length).to.be.greaterThan(300)
    fs.writeFileSync(ledgerFile(), full.slice(0, 300))
}

const DAMAGED_SHAPES = {
    truncated:            () => writeTruncatedDueLedger(),
    'a directory':        () => fs.mkdirSync(ledgerFile()),
    'a dangling symlink': () => fs.symlinkSync(path.join(ledgerDir, 'missing-target.json'), ledgerFile()),
    'mode 000': function () {
        // Root reads through mode 000, so the case only means something as a normal user.
        if (typeof process.getuid === 'function' && process.getuid() === 0) this.skip()
        writeTruncatedDueLedger()
        fs.chmodSync(ledgerFile(), 0o000)
    }
}

function listDueError() {
    try {
        ledger.listRepublishDue()
    } catch (err) {
        return err
    }
    return null
}

function runDue(args) {
    const res = spawnSync(process.execPath, [CLI, 'bootstrap-republish-due', ...args], {
        env: {
            ...process.env,
            XCHAIN_NODE_REINDEX_LEDGER_DIR: ledgerDir,
            XCHAIN_NODE_LOCK_DIR: lockDir,
            // No unit test may reach a real Docker daemon.
            DOCKER_HOST: 'unix:///nonexistent/xchain-node-test-docker.sock'
        },
        encoding: 'utf8',
        timeout: 25000
    })
    return { status: res.status, out: `${res.stdout || ''}`, err: `${res.stderr || ''}` }
}

describe('BootstrapRepublishLedger over a ledger that exists but cannot be read', function () {
    beforeEach(setup)
    afterEach(teardown)

    for (const [label, make] of Object.entries(DAMAGED_SHAPES)) {
        it(`reports the damage instead of reading nothing due when it is ${label}`, function () {
            make.call(this)
            expect(() => ledger.readReindexLedger()).to.throw(ledgerFile())
            const err = listDueError()
            expect(err, 'listRepublishDue() returned instead of reporting the damage').to.be.an('error')
            expect(err.code).to.equal('ELEDGERUNREADABLE')
        })
    }

    it('still reads an absent ledger as clean and empty, with no warning', function () {
        expect(ledger.readReindexLedger()).to.deep.equal({ version: 1, combos: {} })
        expect(ledger.listRepublishDue()).to.deep.equal([])
        expect(warnings).to.deep.equal([])
    })
})

describe('BootstrapRepublishLedger recordBootstrapPublished() over a truncated ledger', function () {
    beforeEach(setup)
    afterEach(teardown)

    it('does not report the publish as recorded, warns, and leaves the bytes alone', function () {
        writeTruncatedDueLedger()
        const before = fs.readFileSync(ledgerFile())
        expect(ledger.recordBootstrapPublished(DECODER, 'bitcoin', 'regtest')).to.equal(false)
        expect(fs.readFileSync(ledgerFile()).equals(before)).to.equal(true)
        expect(fs.readdirSync(ledgerDir)).to.deep.equal(['bootstrap-reindex.json'])
        expect(warnings.some(w => w.includes(ledgerFile()) && w.includes('xchain-decoder:bitcoin:regtest')))
            .to.equal(true)
    })
})

// The publisher runs this command to decide what to republish, so a damaged
// ledger must fail the command rather than print an empty list and exit 0.
describe('the bootstrap-republish-due command over a truncated ledger', function () {
    this.timeout(30000)
    beforeEach(setup)
    afterEach(teardown)

    it('exits non-zero and names the ledger instead of printing an empty list', function () {
        writeTruncatedDueLedger()
        const { status, out, err } = runDue(['--json'])
        expect(status).to.not.equal(0)
        expect(out.trim()).to.not.equal('[]')
        expect(err).to.include(ledgerFile())
        expect(err).to.match(/could not be read/)
    })
})
