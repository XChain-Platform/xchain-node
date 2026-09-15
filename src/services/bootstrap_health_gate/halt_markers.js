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
 * XChain Node - Bootstrap source health gate halt marker probe
 *
 * Reads the durable halt markers (a decoder REORG_HALT row, an uncleared
 * sync_halt row) and the dump-window watermarks straight out of the database
 * about to be dumped, and for an indexer source out of its paired decoder
 * database as well. Every unreadable answer throws, and the gate turns a throw
 * into a refusal.
 *
 ********************************************************************/

const { XChainService, EXTERNAL_DB } = require('../../config')
const { getModuleDatabaseName } = require('../config_service')
const { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
const {
    markerTablesSql, liveReorgHaltCountSql, liveSyncHaltCountSql,
    eventsWatermarkSql, syncHaltWatermarkSql, reorgHaltsSinceSql, syncHaltsSinceSql
} = require('../../db/halt_markers')

// Parse whitespace-separated COUNT(*) output from a `mariadb -BN` probe into
// whole nonnegative integers, throwing on anything else.
//
// `parseInt` is the wrong tool for a fail-closed probe: it reads a PREFIX and
// discards the rest, so '0garbage' becomes 0 and '-1' becomes -1, and both then
// survive `Number.isFinite` and lose every `> 0` comparison the gate makes. That
// turns unreadable probe output into a healthy zero, which is exactly the "we
// could not tell" -> "it is fine" collapse the file header forbids. The token
// count is checked too: a truncated multi-count answer that happens to parse is
// still not the answer to the question that was asked.
//
// `what` names the probe for the refusal reason; `max` bounds a count whose only
// legal values are known (a table-existence count is 0 or 1).
function parseCountTokens(raw, { expected, max = null, what }) {
    const text   = String(raw == null ? '' : raw).trim()
    const tokens = text.length === 0 ? [] : text.split(/\s+/)
    const bad = tokens.length !== expected
        || tokens.some(t => !/^\d+$/.test(t))
        || (max !== null && tokens.some(t => Number(t) > max))
    if (bad)
        throw new Error(`the ${what} returned unreadable output: ${JSON.stringify(text)}`)
    return tokens.map(Number)
}

// The authoritative check for a decoder that is up and looks healthy but is
// quietly carrying a stale halt marker, and the one that does not depend on
// the running image being new enough to report the marker on its health
// surface: read the marker rows straight out of the database being dumped - and,
// for an indexer source, out of the paired decoder database that owns them.
async function readHaltMarkers(coin, network, module, deps, since) {
    const {
        runner,
        getDatabaseContainerId,
        askMariadbRootPassword,
        getExternalDbConfig,
        executeNativeMariaDbCommand
    } = deps

    // A watermark is interpolated into SQL below, and it comes back through a caller
    // chain rather than straight from parseCountTokens, so assert the shape rather
    // than trust it. null means "nothing recorded", which the caller reads as
    // "we could not tell" and refuses on.
    const assertWatermark = (value, what) => {
        if (value === undefined || value === null) return null
        if (!Number.isInteger(value) || value < 0)
            throw new Error(`refusing an unusable ${what} watermark: ${JSON.stringify(value)}`)
        return value
    }

    // The names are derived from coin/network internally, never operator input, but
    // they are interpolated into SQL below; assert the shape rather than trust it.
    const assertDbName = (name) => {
        if (!/^[A-Za-z0-9_]+$/.test(String(name)))
            throw new Error(`refusing to probe an unexpected database name: ${name}`)
        return String(name)
    }
    const dbName = assertDbName(getModuleDatabaseName(module, coin, network))

    const run = async (sql) => {
        if (EXTERNAL_DB) {
            const cfg = await getExternalDbConfig()
            return String(await executeNativeMariaDbCommand(cfg, sql, '-BN'))
        }
        const dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) throw new Error('MariaDB container not found')
        const rootPassword = await askMariadbRootPassword(coin, network)
        const { stdout } = await runner(
            'docker',
            dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', sql, 'information_schema']),
            { env: mariadbEnv(rootPassword) }
        )
        return String(stdout || '')
    }

    // Read one count, refusing on anything that is not a whole nonnegative
    // integer. Output the probe could not produce (an empty string from a
    // mis-parsed client option, a driver that returned nothing, a permission
    // error rendered on stdout) used to reach `parseInt` and lose every `> 0`
    // comparison below, so "we could not tell" arrived at the caller as "no halt
    // markers" - the one collapse the file header forbids.
    const readCount = async (sql, what) => {
        const [value] = parseCountTokens(await run(sql), { expected: 1, what: `${what} probe` })
        return value
    }

    // Probe ONE database for both durable markers. Every failure shape throws, and
    // the caller turns a throw into a refusal reason: that is the whole contract.
    // `since` is a watermark this same function returned at an earlier reading; when
    // it is given the probe additionally reports what was RAISED between the two.
    const probeDatabase = async (name, since) => {
        // One round trip: which marker tables exist, and how many live rows each has.
        // Counting information_schema rows (rather than querying the table directly)
        // keeps an absent table answerable as a 0 instead of an error; deciding what
        // that 0 means is this function's job below, and it is not always "clean".
        const query = markerTablesSql(name)

        // Two tokens, each 0 or 1: TABLE_SCHEMA + TABLE_NAME is unique in
        // information_schema.TABLES, so any other value means the output is not the
        // answer to the question that was asked. Capping at 1 is what makes
        // `1<TAB>0garbage` a refusal instead of a silent [1, 0] that skips the
        // sync_halt probe entirely.
        const [hasEvents, hasSyncHalt] = parseCountTokens(await run(query),
            { expected: 2, max: 1, what: `marker-table probe for ${name}` })

        // `events` is not optional on a decoder/indexer database: both provision it
        // unconditionally at startup (each repo's verifyTables creates every
        // src/sql/*.sql table), and it is the only durable home of the REORG_HALT
        // marker. Its absence therefore means the probe did not read the database
        // it was aimed at - a name drift, a wrong host - which is a refusal, not a
        // clean bill of health.
        if (hasEvents === 0)
            throw new Error(`${name} reports no events table, so the REORG_HALT marker could not be read`)

        const found = { reorgHalt: 0, syncHalt: 0 }
        // LIVE halts only: a REORG_HALT row older than the newest REORG_HALT_CLEARED
        // row was cleared by an operator through `xchain-node clear-reorg-halt`
        // (audited in the decoder's events table) and no longer disqualifies the
        // database. The halt row itself is never deleted, so a plain count would
        // refuse a cleared database forever.
        found.reorgHalt = await readCount(liveReorgHaltCountSql(name), 'REORG_HALT marker')
        // sync_halt IS optional: xchain-sync provisions it only where it runs, so an
        // absent table here is a genuine "no such marker", not an unread database.
        if (hasSyncHalt > 0)
            found.syncHalt = await readCount(liveSyncHaltCountSql(name), 'sync_halt marker')

        // The dump window watermark. Both marker tables are append-only and
        // id-ordered (decoder events: AUTO_INCREMENT, a clear is a NEW row, halt rows
        // are never deleted; sync_halt: AUTO_INCREMENT, a clear sets cleared_at and
        // the row stays), which is what makes "did a halt occur at ANY point since
        // the pre-flight reading" answerable with a MAX(id) taken then and a count
        // taken now. null means the table did not exist at this reading.
        found.watermark = {
            events: await readCount(eventsWatermarkSql(name), `events watermark for ${name}`),
            syncHalt: hasSyncHalt > 0
                ? await readCount(syncHaltWatermarkSql(name), `sync_halt watermark for ${name}`)
                : null
        }

        // Nothing recorded from an earlier reading: this call is the reading.
        if (!since) return found

        // What happened between that reading and this one. A marker RAISED anywhere
        // in the window disqualifies the archive even if it was cleared before this
        // reading, because the --single-transaction snapshot sits inside the window
        // and live state cannot say which side of it the halt landed on. Conservative
        // by construction: a halt raised after the snapshot point also refuses, and
        // publishing nothing beats publishing unverified.
        const raised = { reorgHalt: 0, syncHalt: 0, unreadable: [] }
        const priorEvents = assertWatermark(since.events, `${name}.events`)
        if (priorEvents === null || found.watermark.events < priorEvents) {
            // No recorded watermark, or the sequence went backwards (table recreated,
            // a different database probed): we could not tell, so we refuse.
            raised.unreadable.push(`${name}.events`)
        } else {
            raised.reorgHalt = await readCount(reorgHaltsSinceSql(name, priorEvents),
                `REORG_HALT dump-window probe for ${name}`)
        }
        const priorSyncHalt = assertWatermark(since.syncHalt, `${name}.sync_halt`)
        if (hasSyncHalt === 0) {
            // The table is gone now. If it was there at the earlier reading, something
            // dropped it mid-window and we cannot speak for the rows it held.
            if (priorSyncHalt !== null) raised.unreadable.push(`${name}.sync_halt`)
        } else if (found.watermark.syncHalt < (priorSyncHalt === null ? 0 : priorSyncHalt)) {
            raised.unreadable.push(`${name}.sync_halt`)
        } else {
            // priorSyncHalt null means the table did not exist at the earlier reading,
            // so every row in it now was written inside the window.
            raised.syncHalt = await readCount(
                syncHaltsSinceSql(name, priorSyncHalt === null ? 0 : priorSyncHalt),
                `sync_halt dump-window probe for ${name}`)
        }
        found.raisedInWindow = raised
        return found
    }

    const markers = await probeDatabase(dbName, since && since.own)

    // An xchain-indexer database structurally CANNOT carry the REORG_HALT marker, so
    // the probe above is a guaranteed zero for an indexer source and this backstop had
    // no reach there at all: the indexer only ever writes code='REORG' into its own
    // events table and reads the halt marker out of the DECODER's connection, while
    // the marker row is written solely into the decoder database. Nothing else in the
    // gate covers the gap either - the indexer's decoderReorgHalted mirror defaults
    // false and keeps its last value on any probe fault, and its published lag is
    // measured against the halted decoder's own frozen height, so it reads 0. Probe
    // the paired decoder database as well, fail-closed: probeDatabase throws on an
    // absent database, an absent events table and an unreadable count alike, and every
    // one of those means we could not tell.
    if (module === XChainService.XCHAIN_INDEXER) {
        const decoderDbName = assertDbName(getModuleDatabaseName(XChainService.XCHAIN_DECODER, coin, network))
        let upstream
        try {
            upstream = await probeDatabase(decoderDbName, since && since.upstream)
        } catch (err) {
            // Name the database that actually failed: the caller's wrapper names the
            // GATED module, which would otherwise blame the indexer for the decoder.
            throw new Error(`the paired decoder database ${decoderDbName} could not be probed: ${err && err.message}`)
        }
        markers.upstream = { dbName: decoderDbName, ...upstream }
    }
    return markers
}

module.exports = {
    parseCountTokens,
    readHaltMarkers
}
