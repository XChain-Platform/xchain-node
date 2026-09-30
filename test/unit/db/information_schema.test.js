'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const {
    schemaExistsSql,
    tableCountSql,
    tableExistsSql,
    tablesExistSql,
    schemaSizeSql
} = require('../../../src/db/information_schema')

describe('information_schema SQL builders', () => {
    it('builds the schema existence query', () => {
        expect(schemaExistsSql('xchain_btc')).to.equal(
            "SELECT COUNT(SCHEMA_NAME) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'xchain_btc'"
        )
    })

    it('builds the table count query', () => {
        expect(tableCountSql("'db1'")).to.equal(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'db1'"
        )
    })

    it('builds the table existence query', () => {
        expect(tableExistsSql("'db1'", "'blocks'")).to.equal(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'db1' AND TABLE_NAME = 'blocks'"
        )
    })

    it('builds the multi-table existence query with escaped literals', () => {
        expect(tablesExistSql("'db1'", ['blocks', "o'brien"])).to.equal(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'db1' AND TABLE_NAME IN ('blocks', 'o\\'brien')"
        )
    })

    it('builds the schema size query', () => {
        expect(schemaSizeSql('db1')).to.equal(
            "SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'db1'"
        )
    })
})
