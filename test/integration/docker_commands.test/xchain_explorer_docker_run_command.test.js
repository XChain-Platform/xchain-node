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
const { dockerSuite } = require('./support/fixture')

// Explorer Docker command (shared service)
dockerSuite('xchain-explorer Docker run command', function (fixture) {

    it('uses base network and both HTTP/HTTPS ports', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.createFakeModule('xchain-explorer')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-explorer', null, null, null, true)

        const runCmd = capture.findCommands(/docker run/)[0].command
        expect(runCmd).to.include('--hostname xchain-node-xchain-explorer')
        expect(runCmd).to.include('--network xchain-node')
        expect(runCmd).to.include('-p 18080:8080')
        expect(runCmd).to.include('-p 18081:8081')
    })
})
