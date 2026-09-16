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
const path       = require('path')

describe('Security', function () {
    // SEC-006: helpers.js uses execFile
    describe('helpers.js decompressTarGz safety', function () {

        it('uses execFile instead of exec', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../../src/utils/helpers.js'), 'utf8'
            )
            expect(source).to.include('execFile')
            expect(source).to.not.match(/\bexec\b[^F]/) // no bare exec (only execFile)
        })
    })
})
