'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const fs         = require('fs')
const os         = require('os')
const path       = require('path')

const configModulePath = require.resolve('../../src/config')
const configWasLoaded  = Boolean(require.cache[configModulePath])
const unitConfigDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-unit-config-'))

process.env.XCHAIN_NODE_CONFIG_DIR = unitConfigDir

let cleaned = false
function cleanUnitConfigDir() {
    if (cleaned) return
    cleaned = true
    fs.rmSync(unitConfigDir, { recursive: true, force: true })
}

process.once('exit', cleanUnitConfigDir)
after(cleanUnitConfigDir)

describe('unit config directory isolation', function () {
    it('takes effect before the production config module is loaded', function () {
        expect(configWasLoaded).to.equal(false)
        expect(require('../../src/config').configDir).to.equal(unitConfigDir)
    })

    it('uses an operating-system temporary directory outside the checkout', function () {
        expect(unitConfigDir.startsWith(path.resolve(os.tmpdir()) + path.sep)).to.equal(true)
        expect(unitConfigDir.startsWith(path.resolve(__dirname, '../..') + path.sep)).to.equal(false)
    })
})
