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

dockerSuite('docker build working directory', function (fixture) {

    it('cwd is set to the module directory', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', '')
        env.createFakeModule('xchain-encoder')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)

        const buildCmd = capture.findCommands(/docker build /)[0]
        expect(buildCmd.options.cwd).to.include('xchain-encoder')
    })
})
