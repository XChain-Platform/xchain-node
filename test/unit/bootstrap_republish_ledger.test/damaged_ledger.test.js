'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A reset that finds the republish ledger damaged must not quietly replace it
// with a one-entry file: every other combo's due marker would vanish while the
// reset prints success, and the publisher would never republish those archives.

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const { expect } = require('chai')

const { XChainService } = require('../../../src/config')

const DECODER = XChainService.XCHAIN_DECODER
const INDEXER = XChainService.XCHAIN_INDEXER

const OTHER_DUE  = ['xchain-decoder:bitcoin:regtest', 'xchain-utxo-tracker:litecoin:regtest']
const MARKED_KEY = 'xchain-indexer:dogecoin:regtest'

let ledgerDir, ledger, savedDir, savedWarn, warnings

function setup() {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-republish-damaged-'))
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
    if (savedDir === undefined) delete process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
    else process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = savedDir
    fs.rmSync(ledgerDir, { recursive: true, force: true })
}

function ledgerFile() {
    return path.join(ledgerDir, 'bootstrap-reindex.json')
}

function writeThreeDueCombos() {
    const doc = { version: 1, combos: {} }
    for (const key of [...OTHER_DUE, MARKED_KEY]) {
        doc.combos[key] = { reindexedAt: '2026-10-01T00:00:00.000Z', publishedAt: null, reason: 'reset all' }
    }
    fs.writeFileSync(ledgerFile(), JSON.stringify(doc, null, 2) + '\n')
}

function asideFiles() {
    return fs.readdirSync(ledgerDir).filter(f => f.startsWith('bootstrap-reindex.json.corrupt-'))
}

function markIndexerWithoutThrowing() {
    let marked
    expect(() => {
        marked = ledger.recordReindex([INDEXER], 'dogecoin', 'regtest', { reason: 'reset indexer' })
    }).not.to.throw()
    return marked
}

describe('BootstrapRepublishLedger recordReindex() over a truncated ledger', function () {
    beforeEach(setup)
    afterEach(teardown)

    it('keeps the damaged bytes beside the new ledger and warns where they went', function () {
        writeThreeDueCombos()
        const truncated = fs.readFileSync(ledgerFile(), 'utf8').slice(0, 300)
        expect(() => JSON.parse(truncated)).to.throw()
        fs.writeFileSync(ledgerFile(), truncated)

        expect(markIndexerWithoutThrowing()).to.deep.equal([MARKED_KEY])

        const aside = asideFiles()
        expect(aside).to.have.length(1)
        const kept = fs.readFileSync(path.join(ledgerDir, aside[0]), 'utf8')
        expect(kept).to.equal(truncated)
        for (const key of OTHER_DUE) expect(kept).to.include(key)
        expect(warnings.some(w => w.includes(aside[0]))).to.equal(true)
        expect(fs.readdirSync(ledgerDir).filter(f => f.endsWith('.tmp'))).to.deep.equal([])
    })
})

describe('BootstrapRepublishLedger recordReindex() over a ledger of the wrong shape', function () {
    beforeEach(setup)
    afterEach(teardown)

    it('keeps the file aside and warns before starting clean', function () {
        const wrongShape = JSON.stringify({ version: 1, combos: 'nope' })
        fs.writeFileSync(ledgerFile(), wrongShape)
        expect(ledger.recordReindex([DECODER], 'bitcoin', 'regtest', {})).to.have.length(1)
        const aside = asideFiles()
        expect(aside).to.have.length(1)
        expect(fs.readFileSync(path.join(ledgerDir, aside[0]), 'utf8')).to.equal(wrongShape)
        expect(warnings.some(w => w.includes(aside[0]))).to.equal(true)
    })
})

// A file this user cannot read must not be renamed over, so the mark is refused
// and the caller's own failure path tells the operator to republish by hand.
// Root reads through mode 000, so the case only means something as a normal user.
describe('BootstrapRepublishLedger recordReindex() over an unreadable ledger', function () {
    beforeEach(setup)
    afterEach(teardown)

    it('refuses the mark and leaves the ledger untouched', function () {
        if (typeof process.getuid === 'function' && process.getuid() === 0) this.skip()
        writeThreeDueCombos()
        const before = fs.readFileSync(ledgerFile(), 'utf8')
        fs.chmodSync(ledgerFile(), 0o000)
        let marked
        try {
            marked = markIndexerWithoutThrowing()
        } finally {
            fs.chmodSync(ledgerFile(), 0o600)
        }
        expect(marked).to.deep.equal([])
        expect(fs.readFileSync(ledgerFile(), 'utf8')).to.equal(before)
        expect(ledger.listRepublishDue().map(d => d.combo)).to.deep.equal([...OTHER_DUE, MARKED_KEY].sort())
        expect(warnings.length).to.be.greaterThan(0)
    })
})

describe('BootstrapRepublishLedger recordReindex() with no ledger yet', function () {
    beforeEach(setup)
    afterEach(teardown)

    it('starts clean without a warning or an aside copy', function () {
        expect(fs.existsSync(ledgerFile())).to.equal(false)
        expect(markIndexerWithoutThrowing()).to.deep.equal([MARKED_KEY])
        expect(warnings).to.deep.equal([])
        expect(asideFiles()).to.deep.equal([])
    })
})
