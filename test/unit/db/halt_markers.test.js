'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const haltMarkers = require('../../../src/db/halt_markers')

const expectedExports = [
    'markerTablesSql',
    'liveReorgHaltCountSql',
    'newestReorgClearSql',
    'liveSyncHaltCountSql',
    'pendingSyncHaltCountSql',
    'rollbackGuardStateSql',
    'eventsWatermarkSql',
    'syncHaltWatermarkSql',
    'reorgHaltsSinceSql',
    'syncHaltsSinceSql'
]

describe('halt marker exports and live SQL builders', () => {
    it('exports exactly the supported builders', () => {
        expect(Object.keys(haltMarkers)).to.have.members(expectedExports)
        expect(Object.keys(haltMarkers)).to.have.lengthOf(expectedExports.length)
    })

    it('builds the marker table discovery query', () => {
        const sql = haltMarkers.markerTablesSql('xchain_btc')

        expect(sql).to.include("TABLE_SCHEMA='xchain_btc'")
        expect(sql).to.include("TABLE_NAME='events'")
        expect(sql).to.include("TABLE_NAME='sync_halt'")
        expect(sql).to.include("TABLE_NAME='sync_state'")
        expect(sql).to.match(/;$/)
    })

    it('builds the live reorg halt query', () => {
        const sql = haltMarkers.liveReorgHaltCountSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.events')
        expect(sql).to.include("code='REORG_HALT'")
        expect(sql).to.include("code='REORG_HALT_CLEARED'")
        expect(sql).to.match(/;$/)
    })

    // The decoder reads a newest clear row with no audited reason as a live halt, so the
    // gate fetches that row's bytes and judges them in JavaScript; test/integration runs it on MariaDB.
    it('reads the newest marker row as a clear flag and its payload bytes', () => {
        const sql = haltMarkers.newestReorgClearSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.events')
        expect(sql).to.include("code IN ('REORG_HALT','REORG_HALT_CLEARED')")
        expect(sql).to.include("code='REORG_HALT_CLEARED'")
        expect(sql).to.include('SELECT COUNT(*), MAX(HEX(data))')
        expect(sql).to.not.include('JSON_')
        expect(sql).to.match(/;$/)
    })

    it('builds the pending sync halt query over sync_state', () => {
        const sql = haltMarkers.pendingSyncHaltCountSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.sync_state')
        expect(sql).to.include("state_key LIKE 'halt_pending:%'")
        expect(sql).to.include('CHAR_LENGTH(COALESCE(state_value')
        expect(sql).to.match(/;$/)
    })
})

describe('halt marker exports and live SQL builders', () => {
    it('reads exact rollback guard keys as encoded values', () => {
        const sql = haltMarkers.rollbackGuardStateSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.sync_state')
        expect(sql).to.include("LEFT(state_key, 15) = 'rollback_guard:'")
        expect(sql).to.include("CONCAT('V', HEX(state_value))")
        expect(sql).to.include("state_value IS NULL, 'N'")
        expect(sql).to.not.include('LIKE')
        expect(sql).to.match(/;$/)
    })

    it('builds the live sync halt query', () => {
        const sql = haltMarkers.liveSyncHaltCountSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.sync_halt')
        expect(sql).to.include('cleared_at IS NULL')
        expect(sql).to.match(/;$/)
    })
})

describe('halt marker watermark SQL builders', () => {
    it('builds the events watermark query', () => {
        const sql = haltMarkers.eventsWatermarkSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.events')
        expect(sql).to.match(/;$/)
    })

    it('builds the sync halt watermark query', () => {
        const sql = haltMarkers.syncHaltWatermarkSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.sync_halt')
        expect(sql).to.match(/;$/)
    })

    it('builds the reorg halt query after a watermark', () => {
        const sql = haltMarkers.reorgHaltsSinceSql('xchain_btc', 7)

        expect(sql).to.include('`xchain_btc`.events')
        expect(sql).to.include("'REORG_HALT'")
        expect(sql).to.include('id > 7')
        expect(sql).to.match(/;$/)
    })

    // clear-reorg-halt writes a clear only over a live halt, so any clear in the window counts.
    it('counts every clear row raised after a watermark, without reading its payload', () => {
        const sql = haltMarkers.reorgHaltsSinceSql('xchain_btc', 7)

        expect(sql).to.include("code IN ('REORG_HALT','REORG_HALT_CLEARED') AND id > 7")
        expect(sql).to.not.include('data')
    })

    it('builds the sync halt query after a watermark', () => {
        const sql = haltMarkers.syncHaltsSinceSql('xchain_btc', 7)

        expect(sql).to.include('`xchain_btc`.sync_halt')
        expect(sql).to.include('id > 7')
        expect(sql).to.match(/;$/)
    })
})
