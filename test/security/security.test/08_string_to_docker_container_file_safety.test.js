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
    // SEC-022: stringToDockerContainerFile uses spawn
    describe('stringToDockerContainerFile safety', function () {

        it('uses spawn with tee instead of exec with shell interpolation', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../../src/services/docker_service.js'), 'utf8'
            )
            // Guards against a regression to the earlier broken template literal.
            expect(source).to.not.include("docker exec -i ${containerId}")
            // Should use spawn with tee
            expect(source).to.include("spawn('docker'")
            expect(source).to.include("'tee'")
        })
    })
})
