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
 * XChain Node - a service's migration ledger
 *
 * One read, against the `schema_migrations` table every XChain service keeps.
 * It answers which migrations a database has already applied, which is what the
 * precondition guard compares a new build's migration set against.
 *
 ********************************************************************/

/**
 * Every applied migration name, one per output line. The database is
 * back-quoted rather than passed as a literal because it is an identifier here,
 * not a value, and the caller has already proved it safe.
 */
function appliedMigrationsSql(database, ledgerTable) {
    return 'SELECT name FROM `' + database + '`.' + ledgerTable
}

module.exports = { appliedMigrationsSql }
