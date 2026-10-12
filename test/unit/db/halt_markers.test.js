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
    'liveSyncHaltCountSql',
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
        expect(sql).to.match(/;$/)
    })

    it('builds the live reorg halt query', () => {
        const sql = haltMarkers.liveReorgHaltCountSql('xchain_btc')

        expect(sql).to.include('`xchain_btc`.events')
        expect(sql).to.include("code='REORG_HALT'")
        expect(sql).to.include("code='REORG_HALT_CLEARED'")
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
        expect(sql).to.include("code='REORG_HALT'")
        expect(sql).to.include('id > 7')
        expect(sql).to.match(/;$/)
    })

    it('builds the sync halt query after a watermark', () => {
        const sql = haltMarkers.syncHaltsSinceSql('xchain_btc', 7)

        expect(sql).to.include('`xchain_btc`.sync_halt')
        expect(sql).to.include('id > 7')
        expect(sql).to.match(/;$/)
    })
})
