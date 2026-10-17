/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Migration precondition guard: the recorded ledger
 *
 * An indexer database can embody a manual migration's end state with no
 * ledger row for it. The guard counts that as applied when deciding what is
 * missing, but the indexer runner decides from the ledger, so an unscoped
 * migrate run still executes such a file. The exception is a file listed in
 * that runner's MIGRATION_PRECONDITIONS: when its predicate finds the end
 * state already live, the runner records it as applied without running a
 * statement, while an older build lacking that entry still executes it. The
 * refusal's list of what that run would apply is therefore built from the
 * names the ledger records, and can overcount by such a baselined file.
 ********************************************************************/

const { recordedMigrationsSql } = require('../../db/migration_ledger')

// The names the ledger alone records, or null when that read fails (callers fall back to `applied`).
// A non-indexer database has no schema-satisfied names, so its applied set already is the ledger.
async function readRecordedNames(runner, database, ledgerTable, applied) {
    if (!/_Indexer$/.test(database)) return applied
    try {
        const out = String(await runner(recordedMigrationsSql(database, ledgerTable)))
        return new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
    } catch {
        return null
    }
}

// The note beside one file in the "an unscoped run would apply" list.
function wouldApplyNote(file, carried, remedy) {
    if (carried.includes(file)) return '  (the one you need)'
    if (remedy.schemaMatched && remedy.schemaMatched.has(file)) {
        return '  (the live schema already matches it; no ledger row records it)'
    }
    return ''
}

module.exports = { readRecordedNames, wouldApplyNote }
