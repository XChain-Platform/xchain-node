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
    // SEC-005: GitHubDownloader uses spawnSync
    describe('GitHubDownloader archive extraction safety', function () {

        it('uses spawnSync instead of execSync for tar extraction', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../../src/services/github_downloader.js'), 'utf8'
            )
            expect(source).to.not.include('execSync')
            expect(source).to.include('spawnSync')
        })

        it('uses fs.unlinkSync instead of shell rm for cleanup', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../../src/services/github_downloader.js'), 'utf8'
            )
            expect(source).to.include('fs.unlinkSync')
            // Should not have shell rm in commands
            expect(source).to.not.match(/&& rm /)
        })
    })
})
