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
    // SEC-027: chmod 755 instead of 777
    describe('Bootstrap directory permissions', function () {

        it('uses chmod 755 instead of 777 for bootstrap directories', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../../src/services/bootstrap_service.js'), 'utf8'
            )
            expect(source).to.not.include('chmod 777')
            expect(source).to.include("'755'")
        })
    })
})
