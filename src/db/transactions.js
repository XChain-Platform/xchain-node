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
 * XChain Node - the decoder's `transactions` table
 *
 * The raw-payload reads behind the nine-field FILE scan.
 *
 ********************************************************************/

/**
 * The decoder read. Keyset-paged on tx_index so a full mainnet scan streams rather than
 * loading every FILE transaction at once, and ordered so a resumed scan is deterministic.
 *
 * `data LIKE 'FILE|%' OR data LIKE 'BATCH|%'` is the widest useful filter: a FILE can
 * only reach the chain as a top-level FILE or inside a BATCH, and anything else cannot
 * dispatch as one. It is a filter on the RAW payload, never on parsed params, which is
 * the distinction this whole scan turns on.
 */
function payloadScanSql(limit) {
    return 'SELECT t.tx_index, t.block_index, it.hash AS hash, t.data '
         + 'FROM transactions t '
         + 'LEFT JOIN index_transactions it ON it.id = t.tx_hash_id '
         + 'WHERE t.tx_index > ? AND (t.data LIKE ' + "'FILE|%'" + ' OR t.data LIKE ' + "'BATCH|%'" + ') '
         + 'ORDER BY t.tx_index ASC LIMIT ' + Number(limit)
}

/**
 * The size of the corpus the filtered scan ran against. Reported alongside the
 * scan, because "0 hits" over 0 rows and "0 hits" over 40k rows are different
 * facts and only one of them is a scan.
 *
 * This was not theoretical. The first fleet-wide run printed the confident CLEAN
 * verdict for nine of ten stores whose `transactions` table is EMPTY, and the
 * report gave the reader nothing to tell that apart from a real scan. The
 * verdict was true in both cases; the evidence behind it was not comparable, and
 * a gate that reads identically either way trains people to skim it.
 */
function payloadCorpusSql() {
    return 'SELECT COUNT(*) AS payload_rows FROM transactions '
         + 'WHERE data IS NOT NULL AND data <> ' + "''"
}

module.exports = { payloadScanSql, payloadCorpusSql }
