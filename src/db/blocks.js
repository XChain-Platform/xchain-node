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
 * XChain Node - the `blocks` table of a decoder or indexer database
 *
 * Two reads, both about a database this CLI does not own: how far has it got,
 * and does it hold anything at all. The caller supplies the runner, because the
 * same question is asked over a docker exec and over a native connection.
 *
 ********************************************************************/

/**
 * MAX(block_index) of the decoder/indexer `blocks` table. Both schemas carry the
 * column; the indexer's rows can be sparse but its highest index is still the
 * height a dump reaches.
 */
function tipHeightSql(dbName) {
    return `SELECT MAX(block_index) FROM \`${dbName}\`.blocks`
}

/** How many block rows the database holds. Zero rows is what "fresh" means. */
function rowCountSql(dbName) {
    return `SELECT COUNT(*) FROM \`${dbName}\`.blocks`
}

module.exports = { tipHeightSql, rowCountSql }
