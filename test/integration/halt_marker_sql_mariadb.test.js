'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Run the bootstrap gate's halt-marker SQL on a real MariaDB, through the gate's
// own native path, because JSON, regex and NULL semantics are what decide it.
// Needs TEST_DB_HOST (plus TEST_DB_PORT/USER/PASS); skips visibly without one.

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')

const haltMarkers = require('../../src/db/halt_markers')

const HOST = process.env.TEST_DB_HOST
const DB = process.env.TEST_HALT_MARKER_DB || 'xchain_node_halt_marker_test'
const CFG = {
    host: HOST,
    port: Number(process.env.TEST_DB_PORT || 3306),
    root_user: process.env.TEST_DB_USER || 'root',
    root_password: process.env.TEST_DB_PASS || ''
}

// The decoder's rule (xchain-decoder src/db/reorg_halt.js isAuditedClear), applied the
// way readReorgHaltState applies it: JSON.parse, and a parse failure is no payload.
function decoderAudited(data) {
    let payload = null
    try { payload = (typeof data === 'string') ? JSON.parse(data) : data } catch (_) { payload = null }
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return false
    return typeof payload.reason === 'string' && payload.reason.trim().length >= 8
}

// Clear-row payloads, each with whether the decoder reads it as an audited clear. The gate
// must give the same answer on every one, the JSON.parse quirks a SQL re-creation misses included.
const CLEAR_CASES = [
    { name: 'a clear-reorg-halt payload', data: '{"reason":"range re-parsed and verified","at":"2026-10-19"}', audited: true },
    { name: 'a reason holding an escaped quote', data: '{"reason":"re-parsed \\"blocks\\" 5-9 and verified"}', audited: true },
    { name: 'exactly eight chars after trim', data: '{"reason":"  12345678  "}', audited: true },
    { name: 'a JSON-escaped reason', data: '{"reason":"\\u0041BCDEFGH"}', audited: true },
    { name: 'NBSP around a valid reason', data: '{"reason":"\\u00a0abcdefgh\\u00a0"}', audited: true },
    { name: 'a lone escaped surrogate', data: '{"reason":"long enough \\ud800reason"}', audited: true },
    { name: 'NEL padding, which trim keeps', data: '{"reason":"\u0085\u0085abc\u0085\u0085\u0085\u0085"}', audited: true },
    { name: 'a short reason', data: '{"reason":"short"}', audited: false },
    { name: 'padding that trims to six', data: '{"reason":"   padded   "}', audited: false },
    { name: 'eight tabs', data: '{"reason":"\\t\\t\\t\\t\\t\\t\\t\\t"}', audited: false },
    { name: 'eight NBSPs', data: '{"reason":"' + '\\u00a0'.repeat(8) + '"}', audited: false },
    { name: 'eight ideographic spaces', data: '{"reason":"' + '\\u3000'.repeat(8) + '"}', audited: false },
    { name: 'eight byte-order marks', data: '{"reason":"' + '\\ufeff'.repeat(8) + '"}', audited: false },
    { name: 'no reason', data: '{"at":"2026-10-19"}', audited: false },
    { name: 'a numeric reason', data: '{"reason":12345678}', audited: false },
    { name: 'an array reason', data: '{"reason":["abcdefghij"]}', audited: false },
    { name: 'a nested reason', data: '{"x":{"reason":"abcdefghij"}}', audited: false },
    { name: 'a top-level array', data: '[{"reason":"abcdefghij"}]', audited: false },
    { name: 'JSON null', data: 'null', audited: false },
    { name: 'an empty string', data: '', audited: false },
    { name: 'SQL NULL', data: null, audited: false },
    { name: 'plain text', data: 'operator cleared it', audited: false },
    { name: 'trailing garbage', data: '{"reason":"abcdefghij"} x', audited: false },
    { name: 'a trailing comma', data: '{"reason":"long enough reason",}', audited: false },
    { name: 'a raw tab inside the reason', data: '{"reason":"long enough\treason"}', audited: false },
    { name: 'a raw newline inside the reason', data: '{"reason":"long enough\nreason"}', audited: false },
    { name: 'a raw 0x01 inside the reason', data: '{"reason":"long enough\u0001reason"}', audited: false },
    { name: 'a byte-order mark before the object', data: '﻿{"reason":"long enough reason"}', audited: false },
    { name: 'an invalid \\x escape', data: '{"reason":"long enough reason\\x41"}', audited: false },
    { name: 'a duplicate key whose last copy is short', data: '{"reason":"long enough reason","reason":"x"}', audited: false },
    { name: 'a duplicate key whose last copy is long', data: '{"reason":"x","reason":"long enough reason"}', audited: true },
    { name: 'an escaped duplicate key whose last copy is short', data: '{"reason":"long enough reason","re\\u0061son":"x"}', audited: false },
    { name: 'an escaped duplicate key whose last copy is long', data: '{"reason":"x","re\\u0061son":"long enough reason"}', audited: true },
    { name: 'an escaped first letter in a duplicate key', data: '{"reason":"long enough reason","\\u0072eason":"x"}', audited: false }
]

const AUDITED = '{"reason":"range re-parsed and verified"}'
const UNAUDITED = '{"reason":"oops"}'
const HALT = '{"reason":"over-deep rollback"}'

// Hold the connection and gate modules the before hook loads.
let conn, mariadbExec, parseCountTokens, parseNewestClear, parseRollbackGuardRows

// Create the scratch database the gate's SQL reads.
async function createScratchDb() {
    if (!HOST) this.skip()
    const mariadb = require('mariadb')
    mariadbExec = require('../../src/services/database_service/mariadb_exec')
    ;({ parseCountTokens, parseNewestClear, parseRollbackGuardRows } =
        require('../../src/services/bootstrap_health_gate/halt_markers'))
    conn = await mariadb.createConnection({
        host: CFG.host, port: CFG.port, user: CFG.root_user, password: CFG.root_password
    })
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await conn.query(`CREATE DATABASE \`${DB}\``)
    // Same shape as xchain-decoder src/sql/events.sql and xchain-sync's sync_state.
    await conn.query(`CREATE TABLE \`${DB}\`.events (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, ` +
        'time DATETIME, code VARCHAR(32), data MEDIUMTEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci')
    await conn.query(`CREATE TABLE \`${DB}\`.sync_state (state_key VARCHAR(128) NOT NULL PRIMARY KEY, ` +
        'state_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci')
}

// Drop the scratch database and close the connection, if one opened.
async function dropScratchDb() {
    if (!conn) return
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await conn.end()
}

// Run one builder through the gate's own transport and parser.
async function count(sql) {
    const raw = await mariadbExec.executeNativeMariaDbCommand(CFG, sql, '-BN')
    return parseCountTokens(raw, { expected: 1, what: 'test probe' })[0]
}

async function events(rows) {
    await conn.query(`TRUNCATE TABLE \`${DB}\`.events`)
    for (const [code, data] of rows)
        await conn.query(`INSERT INTO \`${DB}\`.events (time, code, data) VALUES (NOW(), ?, ?)`, [code, data])
}

// The gate's live reorg reading, composed as readLiveMarkers composes it.
async function liveReorgHalts() {
    const raw = await mariadbExec.executeNativeMariaDbCommand(CFG, haltMarkers.newestReorgClearSql(DB), '-BN')
    return (await count(haltMarkers.liveReorgHaltCountSql(DB))) + parseNewestClear(raw, 'test clear probe')
}

async function readsMarkerTables() {
    const raw = await mariadbExec.executeNativeMariaDbCommand(CFG, haltMarkers.markerTablesSql(DB), '-BN')
    expect(parseCountTokens(raw, { expected: 3, max: 1, what: 'test probe' })).to.deep.equal([1, 0, 1])
}

function listsDecoderAnswers() {
    const differ = CLEAR_CASES.filter(c => decoderAudited(c.data) !== c.audited).map(c => c.name)
    expect(differ).to.deep.equal([])
}

// The reference above is a copy, so also ask the real decoder when that sibling is checked out.
async function matchesRealDecoder() {
    const decoderRoot = path.join(__dirname, '../../../xchain-decoder')
    if (!fs.existsSync(path.join(decoderRoot, 'src/db.js'))) this.skip()
    const Database = require(path.join(decoderRoot, 'src/db.js'))
    const decoder = new Database(CFG.host, CFG.port, DB, CFG.root_user, CFG.root_password)
    const differ = []
    try {
        for (const c of CLEAR_CASES) {
            await events([['REORG_HALT', HALT], ['REORG_HALT_CLEARED', c.data]])
            const halted = (await decoder.readReorgHaltState()).halted
            if (halted !== ((await liveReorgHalts()) > 0)) differ.push(c.name)
            if (halted !== !c.audited) differ.push(c.name + ' (table)')
        }
    } finally {
        await decoder.close()
    }
    expect(differ).to.deep.equal([])
}

async function readsNewestMarkerRow() {
    await events([])
    expect(await liveReorgHalts()).to.equal(0)
    await events([['REORG_HALT', '{}']])
    expect(await liveReorgHalts()).to.equal(1)
    await events([['REORG_HALT', '{}'], ['REORG_HALT_CLEARED', AUDITED], ['REORG_HALT', '{}']])
    expect(await liveReorgHalts()).to.equal(1)
    await events([['REORG_HALT', '{}'], ['REORG_HALT_CLEARED', UNAUDITED], ['REORG_HALT_CLEARED', AUDITED]])
    expect(await liveReorgHalts()).to.equal(0)
    await events([['REORG_HALT', '{}'], ['REORG_HALT_CLEARED', AUDITED], ['REORG_HALT_CLEARED', UNAUDITED]])
    expect(await liveReorgHalts()).to.equal(1)
    // Rows of other codes never decide it.
    await events([['REORG_HALT', '{}'], ['REORG_HALT_CLEARED', AUDITED], ['REORG', '[]']])
    expect(await liveReorgHalts()).to.equal(0)
}

async function countsClearsInWindow() {
    await events([['REORG_HALT', '{}'], ['REORG_HALT_CLEARED', AUDITED]])
    const [{ w }] = await conn.query(`SELECT MAX(id) AS w FROM \`${DB}\`.events`)
    expect(await count(haltMarkers.reorgHaltsSinceSql(DB, Number(w)))).to.equal(0)
    await conn.query(`INSERT INTO \`${DB}\`.events (time, code, data) VALUES (NOW(), 'REORG', '[]')`)
    expect(await count(haltMarkers.reorgHaltsSinceSql(DB, Number(w)))).to.equal(0)
    await conn.query(`INSERT INTO \`${DB}\`.events (time, code, data) VALUES (NOW(), 'REORG_HALT_CLEARED', ?)`, [AUDITED])
    expect(await count(haltMarkers.reorgHaltsSinceSql(DB, Number(w)))).to.equal(1)
    await conn.query(`INSERT INTO \`${DB}\`.events (time, code, data) VALUES (NOW(), 'REORG_HALT_CLEARED', ?)`, [UNAUDITED])
    expect(await count(haltMarkers.reorgHaltsSinceSql(DB, Number(w)))).to.equal(2)
}

async function countsPendingSyncHalts() {
    const set = async (rows) => {
        await conn.query(`TRUNCATE TABLE \`${DB}\`.sync_state`)
        for (const [k, v] of rows)
            await conn.query(`INSERT INTO \`${DB}\`.sync_state (state_key, state_value) VALUES (?, ?)`, [k, v])
    }
    await set([['verified_tip:indexer', '812345']])
    expect(await count(haltMarkers.pendingSyncHaltCountSql(DB))).to.equal(0)
    // A dropped copy is deleted or overwritten with '' (restorePendingHalt reads both as none).
    await set([['halt_pending:indexer', ''], ['halt_pending:decoder', null]])
    expect(await count(haltMarkers.pendingSyncHaltCountSql(DB))).to.equal(0)
    await set([['halt_pending:indexer', '{"blockIndex":5,"reason":"state-hash-mismatch"}']])
    expect(await count(haltMarkers.pendingSyncHaltCountSql(DB))).to.equal(1)
    // A blank copy is not '' to the producer, which holds on it as unreadable.
    await set([['halt_pending:decoder', ' ']])
    expect(await count(haltMarkers.pendingSyncHaltCountSql(DB))).to.equal(1)
}

async function readsRollbackGuardStates() {
    await conn.query(`TRUNCATE TABLE \`${DB}\`.sync_state`)
    const rows = [
        ['rollback_guard:indexer', '{"peak":5,"low":3}'],
        ['rollback_guard:decoder', '{"peak":1,"low":2}'],
        ['rollback_guard:empty', ''],
        ['rollback_guard:null', null],
        ['rollbackXguard:ignored', 'not json']
    ]
    for (const [key, value] of rows)
        await conn.query(`INSERT INTO \`${DB}\`.sync_state (state_key, state_value) VALUES (?, ?)`, [key, value])
    const raw = await mariadbExec.executeNativeMariaDbCommand(CFG, haltMarkers.rollbackGuardStateSql(DB), '-BN')
    expect(parseRollbackGuardRows(raw, 'test rollback guard probe')).to.equal(2)
}

// The reference above is a copy, so pin it to the decoder's source when that sibling is checked out.
function pinsReferenceRule() {
    const src = path.join(__dirname, '../../../xchain-decoder/src/db/reorg_halt.js')
    if (!fs.existsSync(src)) this.skip()
    const text = fs.readFileSync(src, 'utf8')
    const gate = fs.readFileSync(path.join(__dirname, '../../src/services/bootstrap_health_gate/halt_markers.js'), 'utf8')
    for (const rule of ["typeof payload.reason === 'string' && payload.reason.trim().length >= 8",
        "payload == null || typeof payload !== 'object' || Array.isArray(payload)"]) {
        expect(text, 'decoder rule').to.include(rule)
        expect(gate, 'gate copy').to.include(rule)
    }
}

describe('halt marker SQL on MariaDB', function () {
    this.timeout(30000)

    before(createScratchDb)
    after(dropScratchDb)

    it('reads the three marker tables as three tokens', readsMarkerTables)
    it('lists each payload with the answer the decoder rule gives it', listsDecoderAnswers)

    for (const c of CLEAR_CASES) {
        it(`a newest clear row with ${c.name} reads as the decoder reads it`, async function () {
            await events([['REORG_HALT', HALT], ['REORG_HALT_CLEARED', c.data]])
            expect(await liveReorgHalts(), 'gate live reorg count').to.equal(c.audited ? 0 : 1)
        })
    }

    it('gives the real decoder readReorgHaltState answer on every payload', matchesRealDecoder)
    it('reads the newest marker row, as the decoder does', readsNewestMarkerRow)
    it('counts every clear row raised inside the dump window, audited or not', countsClearsInWindow)
    it('counts every halt_pending copy that xchain-sync would restore', countsPendingSyncHalts)
    it('reads valid, invalid, empty and NULL rollback guard rows', readsRollbackGuardStates)
    it('keeps the reference rule in step with the decoder', pinsReferenceRule)
})
