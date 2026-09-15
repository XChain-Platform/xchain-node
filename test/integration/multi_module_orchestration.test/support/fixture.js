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

const TestEnv        = require('../../helpers/test-env')
const CommandCapture = require('../../helpers/command-capture')

function multiModuleSuite(title, registerTests) {
    describe('Integration: Multi-Module Orchestration', function () {
        this.timeout(15000)

        let env, capture

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
            env.patchConstants()
            capture = new CommandCapture()
        })

        afterEach(async function () {
            await env.teardown()
        })

        describe(title, function () {
            registerTests(() => ({ env, capture, TestEnv }))
        })
    })
}

module.exports = { multiModuleSuite }
