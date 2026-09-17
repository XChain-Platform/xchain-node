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

function registerPendingManualMigrations({ fs, os, path, expect, pendingManualMigrations, TAGGED }) {
    describe('pendingManualMigrations', () => {

        let dir
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-pending-'))
            fs.writeFileSync(path.join(dir, 'a-manual.sql'), TAGGED)
            fs.writeFileSync(path.join(dir, 'b-auto.sql'), '-- xchain:migration mode=auto\nSELECT 1;\n')
            fs.writeFileSync(path.join(dir, 'c-manual.sql'), '-- xchain:migration mode=manual\nSELECT 1;\n')
        })
        afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

        it('lists only manual migrations the ledger has not recorded', () => {
            expect(pendingManualMigrations(dir, new Set())).to.deep.equal(['a-manual.sql', 'c-manual.sql'])
        })

        it('excludes what the ledger already carries', () => {
            expect(pendingManualMigrations(dir, new Set(['a-manual.sql']))).to.deep.equal(['c-manual.sql'])
        })

        it('yields nothing for a missing directory rather than throwing', () => {
            expect(pendingManualMigrations(path.join(dir, 'nope'), new Set())).to.deep.equal([])
        })
    })
}

function registerRealIndexerInventory({ fs, expect, listDeployPreconditionMigrations, GATED,
                                        INDEXER_DIR, INDEXER_MIGRATIONS, INDEXER_PRESENT, REQUIRE_SIBLINGS }) {
    it('reads the REAL indexer tree and finds the migration behind the 2026-08-09 halt', function () {
        // Guards the whole contract end to end: if the tag is ever dropped from the
        // committed file, or the migrations path moves, this guard must stop the
        // suite rather than pass silently on a directory that no longer exists.
        if (!INDEXER_PRESENT) {
            if (REQUIRE_SIBLINGS)
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
            return this.skip()      // sibling repo not checked out
        }
        expect(fs.existsSync(INDEXER_MIGRATIONS), 'xchain-indexer is checked out at ' + INDEXER_DIR
            + ' but has no migrations directory at ' + INDEXER_MIGRATIONS).to.equal(true)
        expect(listDeployPreconditionMigrations(INDEXER_MIGRATIONS)).to.include(GATED)
    })

    it('reads the REAL indexer tree and finds the bridge-tables migration', function () {
        // The bridge build lands `2026-09-12-bridge-tables.sql` (mode=manual,
        // deploy-precondition=required) beside the token-bridge-fields migration
        // (mode=auto, no precondition). Nothing in xchain-node had to change for
        // either to be covered: this guard is a directory scan of whatever the
        // target tree carries, so a new deploy-precondition migration is wired in
        // the moment it lands on the indexer, no xchain-node release required
        // (the same "no coupled release" property MigrationPreconditionService's
        // header describes for the contract as a whole). This test is the proof.
        if (!INDEXER_PRESENT) {
            if (REQUIRE_SIBLINGS)
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
            return this.skip()      // sibling repo not checked out
        }
        expect(fs.existsSync(INDEXER_MIGRATIONS), 'xchain-indexer is checked out at ' + INDEXER_DIR
            + ' but has no migrations directory at ' + INDEXER_MIGRATIONS).to.equal(true)
        const required = listDeployPreconditionMigrations(INDEXER_MIGRATIONS)
        expect(required).to.include('2026-09-12-bridge-tables.sql')
        expect(required).to.not.include('2026-09-12-token-bridge-fields.sql')
    })
}

function registerListDeployPreconditionMigrations(deps) {
    const { fs, os, path, expect, listDeployPreconditionMigrations, TAGGED, UNTAGGED } = deps
    describe('listDeployPreconditionMigrations', () => {
        let dir
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-mig-'))
        })
        afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

        it('returns only the tagged .sql files, sorted', () => {
            fs.writeFileSync(path.join(dir, '2026-07-24-b.sql'), TAGGED)
            fs.writeFileSync(path.join(dir, '2026-07-01-a.sql'), TAGGED)
            fs.writeFileSync(path.join(dir, '2026-07-30-c.sql'), UNTAGGED)
            fs.writeFileSync(path.join(dir, 'notes.txt'), TAGGED)
            expect(listDeployPreconditionMigrations(dir)).to.deep.equal(['2026-07-01-a.sql', '2026-07-24-b.sql'])
        })

        it('returns [] for a missing directory (a ref with no migrations declares nothing)', () => {
            expect(listDeployPreconditionMigrations(path.join(dir, 'nope'))).to.deep.equal([])
        })

        registerRealIndexerInventory(deps)
    })
}

function registerMigrationInventory(deps) {
    registerPendingManualMigrations(deps)
    registerListDeployPreconditionMigrations(deps)
}

module.exports = registerMigrationInventory
