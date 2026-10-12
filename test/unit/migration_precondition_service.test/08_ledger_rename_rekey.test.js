'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The deploy guard re-keys the ledger with the target tree's own rename map, the
// way the indexer runner does at boot, and re-keys nothing when that map cannot
// be read exactly.

const fs = require('fs')
const os = require('os')
const path = require('path')
const sinon = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../../src/config')
const { assertRequiredMigrationsApplied } = require('../../../src/services/migration_precondition_service')
const { readLedgerRenames, rekeyApplied } = require('../../../src/services/migration_precondition_service/migration_scan')
const { migrationsDirOf } = require('../../../src/utils/migration_files')

const INDEXER_DIR = path.join(__dirname, '../../../../xchain-indexer')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
const OLD = '2026-09-09-gated.sql'
const NEW = '2026-09-13-gated.sql'

const REGISTRY = [
    "const Database = require('../index.js');",
    '',
    'const MIGRATION_LEDGER_RENAMES = {',
    "    'add_balances_composite_index.sql':  '2026-05-30-balances-composite-index.sql',",
    '    // a full-line comment inside the literal is skipped',
    '',
    "    '" + OLD + "': '" + NEW + "',",
    '};',
    ''
].join('\n')

function treeWith(registryText) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-renames-'))
    if (registryText !== null) {
        fs.mkdirSync(path.join(root, 'src/db/database'), { recursive: true })
        fs.writeFileSync(path.join(root, 'src/db/database/migration_registry.js'), registryText)
    }
    return root
}

function guardDeps({ applied, renames, pendingManual = [] }) {
    return {
        cloneGit: sinon.stub().resolves(),
        listDeployPreconditionMigrations: sinon.stub().returns([NEW]),
        readAppliedMigrations: sinon.stub().resolves({ state: 'ledger', applied: new Set(applied) }),
        runningBuildSupportsPerFileMigrations: sinon.stub().resolves(true),
        pendingManualMigrations: sinon.stub().returns(pendingManual),
        readLedgerRenames: sinon.stub().returns(renames)
    }
}

async function refusalOf(deps) {
    try {
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
    } catch (err) { return err }
    return null
}

let warn

// Stub console.warn around each test in the calling describe, exposed as `warn`.
function installWarnStub() {
    beforeEach(() => { warn = sinon.stub(console, 'warn') })
    afterEach(() => { warn.restore() })
}

describe('migration precondition guard: ledger rename re-key', () => {
    installWarnStub()

    describe('readLedgerRenames', () => {
        it('parses the literal into its exact map, skipping comments and blank lines', () => {
            const res = readLedgerRenames(treeWith(REGISTRY))
            expect(res.state).to.equal('parsed')
            expect(res.renames).to.deep.equal({
                'add_balances_composite_index.sql': '2026-05-30-balances-composite-index.sql',
                [OLD]: NEW
            })
        })

        it('calls a tree with no registry file absent, with an empty map', () => {
            const res = readLedgerRenames(treeWith(null))
            expect(res.state).to.equal('absent')
            expect(res.renames).to.deep.equal({})
        })

        it('refuses the whole map when any line inside the literal is not a quoted pair', () => {
            for (const bad of ['    ...EXTRA,', '    [computed]: \'x.sql\',', '    "a.sql": "b.sql",', "    'a.sql': `b.sql`,"]) {
                const res = readLedgerRenames(treeWith(REGISTRY.replace('    // a full-line', bad + '\n    // a full-line')))
                expect(res.state, bad).to.equal('unparseable')
                expect(res.renames, bad).to.deep.equal({})
            }
        })

        it('refuses a repeated or self-mapped key and an unclosed literal', () => {
            const dup = REGISTRY.replace('};', "    '" + OLD + "': 'other.sql',\n};")
            expect(readLedgerRenames(treeWith(dup)).state).to.equal('unparseable')
            const self = REGISTRY.replace('};', "    'same.sql': 'same.sql',\n};")
            expect(readLedgerRenames(treeWith(self)).state).to.equal('unparseable')
            expect(readLedgerRenames(treeWith(REGISTRY.replace('};', ''))).state).to.equal('unparseable')
        })
    })

    describe('rekeyApplied', () => {
        it('moves a recorded old name to its new name without touching the input', () => {
            const input = new Set([OLD, 'other.sql'])
            const out = rekeyApplied(input, { [OLD]: NEW })
            expect([...out]).to.have.members([NEW, 'other.sql'])
            expect([...input]).to.have.members([OLD, 'other.sql'])
        })

        it('leaves the set alone when the new name is already recorded or the old one is not', () => {
            expect([...rekeyApplied(new Set([OLD, NEW]), { [OLD]: NEW })]).to.have.members([OLD, NEW])
            expect([...rekeyApplied(new Set(['other.sql']), { [OLD]: NEW })]).to.have.members(['other.sql'])
        })

        it('plans every move against the input set, as the runner planner does', () => {
            const out = rekeyApplied(new Set(['a.sql']), { 'a.sql': 'b.sql', 'b.sql': 'c.sql' })
            expect([...out]).to.have.members(['b.sql'])
        })
    })
})

describe('migration precondition guard: ledger rename re-key', () => {
    installWarnStub()

    describe('assertRequiredMigrationsApplied', () => {
        it('passes a database that recorded the precondition under its pre-rename name', async () => {
            const deps = guardDeps({ applied: [OLD], renames: { state: 'parsed', renames: { [OLD]: NEW } } })
            expect(await refusalOf(deps)).to.equal(null)
        })

        it('still refuses when the target tree carries no rename map', async () => {
            const deps = guardDeps({ applied: [OLD], renames: { state: 'absent', renames: {} } })
            const err = await refusalOf(deps)
            expect(err, 'the deploy must be refused').to.not.equal(null)
            expect(err.message).to.contain(NEW)
        })

        it('still refuses, and says why, when the rename map is unparseable', async () => {
            const deps = guardDeps({ applied: [OLD], renames: { state: 'unparseable', renames: { [OLD]: NEW }, reason: 'line 9' } })
            const err = await refusalOf(deps)
            expect(err, 'the deploy must be refused').to.not.equal(null)
            expect(warn.getCalls().map(c => String(c.args[0])).join(' ')).to.contain('rename map was not used')
        })

        it('lists pending manual files against the re-keyed ledger', async () => {
            const MANUAL_OLD = '2026-09-01-manual.sql'
            const MANUAL_NEW = '2026-09-14-manual.sql'
            const deps = guardDeps({
                applied: [MANUAL_OLD],
                renames: { state: 'parsed', renames: { [MANUAL_OLD]: MANUAL_NEW } },
                pendingManual: [NEW]
            })
            const err = await refusalOf(deps)
            expect(err, 'the deploy must be refused').to.not.equal(null)
            const seen = deps.pendingManualMigrations.firstCall.args[1]
            expect(seen.has(MANUAL_NEW)).to.equal(true)
            expect(seen.has(MANUAL_OLD)).to.equal(false)
        })
    })
})

describe('migration precondition guard: ledger rename re-key', () => {
    installWarnStub()

    describe('sibling parity', () => {
        it('parses the real indexer registry into exactly MIGRATION_LEDGER_RENAMES', function () {
            if (!fs.existsSync(INDEXER_DIR)) {
                if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
                return this.skip()      // sibling repo not checked out
            }
            const res = readLedgerRenames(INDEXER_DIR)
            expect(res.state, res.reason).to.equal('parsed')
            let registry = null
            try {
                registry = require(path.join(INDEXER_DIR, 'src/db/database/migration_registry.js'))
            } catch {
                registry = null     // indexer dependencies not installed
            }
            if (registry && registry.MIGRATION_LEDGER_RENAMES) {
                expect(res.renames).to.deep.equal(registry.MIGRATION_LEDGER_RENAMES)
                return
            }
            const files = new Set(fs.readdirSync(migrationsDirOf(INDEXER_DIR)))
            expect(Object.keys(res.renames)).to.not.have.length(0)
            for (const [from, to] of Object.entries(res.renames)) {
                expect(files.has(to), to + ' exists in the indexer tree').to.equal(true)
                expect(files.has(from), from + ' no longer exists in the indexer tree').to.equal(false)
            }
        })
    })
})
