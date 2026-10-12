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

const { expect } = require('chai')
const constants = require('../../../src/config/module_names')

const NAME_KEYS = [
    'NODE_MODULE_NAME',
    'DB_MODULE_NAME',
    'HUB_MODULE_NAME',
    'EXPLORER_MODULE_NAME',
    'SYNC_MODULE_NAME',
    'NODE_VERSION_FILE_NAME'
]
const MODULE_KEYS = NAME_KEYS.filter(key => key.endsWith('_MODULE_NAME'))

describe('module names', function () {
    it('covers every exported module and file name', function () {
        const exportedNameKeys = Object.keys(constants)
            .filter(key => /_(?:MODULE|FILE)_NAME$/.test(key))
        expect(exportedNameKeys).to.have.members(NAME_KEYS)
    })

    it('exports non-empty strings for every module and file name', function () {
        for (const key of NAME_KEYS) {
            expect(constants[key], key).to.be.a('string').and.not.be.empty
        }
    })

    it('keeps every module and file name free of whitespace and path separators', function () {
        for (const key of NAME_KEYS) {
            expect(constants[key], key).to.not.match(/[\s\\/]/)
        }
    })

    it('keeps module names pairwise distinct', function () {
        const moduleNames = MODULE_KEYS.map(key => constants[key])
        expect(new Set(moduleNames).size).to.equal(moduleNames.length)
    })
})
