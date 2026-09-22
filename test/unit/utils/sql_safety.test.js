'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../../../src/utils/sql_safety')

describe('sql_safety', () => {
    describe('assertSafeDbIdentifier', () => {
        it('returns a safe identifier unchanged', () => {
            expect(assertSafeDbIdentifier('xchain_btc_mainnet')).to.equal('xchain_btc_mainnet')
        })

        it('throws naming the kind for an unsafe identifier', () => {
            expect(() => assertSafeDbIdentifier("evil'; DROP", 'database name'))
                .to.throw(/Unsafe MariaDB database name/)
        })
    })

    describe('escapeSqlStringLiteral', () => {
        it('backslash-escapes a quote and returns one quoted literal', () => {
            expect(escapeSqlStringLiteral("x'; DROP DATABASE d; --"))
                .to.equal('\'x\\\'; DROP DATABASE d; --\'')
        })

        it('escapes the NUL, the newline and a backslash per the switch table', () => {
            expect(escapeSqlStringLiteral('a\0b\nc')).to.equal('\'a\\0b\\nc\'')
        })
    })
})
