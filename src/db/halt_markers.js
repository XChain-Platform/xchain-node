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
 * XChain Node - the durable halt markers: `events` and `sync_halt`
 *
 * A bootstrap archive may not be published from a database that halted, and
 * these are the statements that ask whether one did. Two tables, one question,
 * so they share a file.
 *
 * WHY EVERY COUNT IS ASKED AS A COUNT. The caller turns an unparseable answer
 * into a refusal, and that only works if each statement returns a fixed number
 * of plain integers. A read shaped any other way arrives as "we could not tell"
 * dressed up as "no halt markers", which is the collapse this gate exists to
 * prevent.
 *
 ********************************************************************/

/**
 * Which marker tables exist in one database, as two 0-or-1 tokens on one round
 * trip. Counting information_schema rows (rather than querying the table
 * directly) keeps an absent table answerable as a 0 instead of an error;
 * deciding what that 0 means is the caller's job, and it is not always "clean".
 */
function markerTablesSql(name) {
    return `SELECT ` +
        `(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${name}' AND TABLE_NAME='events'), ` +
        `(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${name}' AND TABLE_NAME='sync_halt');`
}

/**
 * LIVE reorg halts only. A REORG_HALT row older than the newest
 * REORG_HALT_CLEARED row was cleared by an operator through
 * `xchain-node clear-reorg-halt` (audited in the decoder's events table) and no
 * longer disqualifies the database. The halt row itself is never deleted, so a
 * plain count would refuse a cleared database forever.
 */
function liveReorgHaltCountSql(name) {
    return `SELECT COUNT(*) FROM \`${name}\`.events WHERE code='REORG_HALT' ` +
        `AND id > COALESCE((SELECT MAX(id) FROM \`${name}\`.events WHERE code='REORG_HALT_CLEARED'), 0);`
}

/** Live sync halts: a cleared row keeps its cleared_at, so NULL is what "still halted" means. */
function liveSyncHaltCountSql(name) {
    return `SELECT COUNT(*) FROM \`${name}\`.sync_halt WHERE cleared_at IS NULL;`
}

/**
 * The dump-window watermark for the events table.
 *
 * Both marker tables are append-only and id-ordered (decoder events:
 * AUTO_INCREMENT, a clear is a NEW row, halt rows are never deleted; sync_halt:
 * AUTO_INCREMENT, a clear sets cleared_at and the row stays), which is what
 * makes "did a halt occur at ANY point since the pre-flight reading" answerable
 * with a MAX(id) taken then and a count taken now.
 */
function eventsWatermarkSql(name) {
    return `SELECT COALESCE(MAX(id),0) FROM \`${name}\`.events;`
}

/** The same watermark for sync_halt, read only where that table exists. */
function syncHaltWatermarkSql(name) {
    return `SELECT COALESCE(MAX(id),0) FROM \`${name}\`.sync_halt;`
}

/**
 * Reorg halts RAISED since a watermark. A marker raised anywhere in the dump
 * window disqualifies the archive even if it was cleared before this reading,
 * because the snapshot sits inside the window and live state cannot say which
 * side of it the halt landed on.
 */
function reorgHaltsSinceSql(name, priorEvents) {
    return `SELECT COUNT(*) FROM \`${name}\`.events WHERE code='REORG_HALT' AND id > ${priorEvents};`
}

/** Sync halts raised since a watermark, same window and same conservatism. */
function syncHaltsSinceSql(name, priorSyncHalt) {
    return `SELECT COUNT(*) FROM \`${name}\`.sync_halt WHERE id > ${priorSyncHalt};`
}

module.exports = {
    markerTablesSql,
    liveReorgHaltCountSql,
    liveSyncHaltCountSql,
    eventsWatermarkSql,
    syncHaltWatermarkSql,
    reorgHaltsSinceSql,
    syncHaltsSinceSql
}
