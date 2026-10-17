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
 *
 * XChain Node - migration ledger reads
 *
 * The statement that lists the names a migration ledger records on its own,
 * with no schema-satisfied names folded in. The migrate runner reads only
 * the ledger, so this is the set an unscoped run treats as already applied.
 *
 ********************************************************************/

// Every name the ledger table itself records.
function recordedMigrationsSql(database, ledgerTable) {
    return 'SELECT name FROM `' + database + '`.' + ledgerTable
}

module.exports = { recordedMigrationsSql }
