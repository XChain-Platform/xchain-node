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
const realConfig = require('../../../src/config')

// Hub Docker command (shared service)
dockerSuite('xchain-hub Docker run command', function (fixture) {

    it('uses base network and hub port', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.createFakeModule('xchain-hub')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-hub', null, null, null, true)

        const buildCmd = capture.findCommands(/docker build /)[0].command
        expect(buildCmd).to.include('-t xchain-node-xchain-hub')

        const runCmd = capture.findCommands(/docker run/)[0].command
        expect(runCmd).to.include('--hostname xchain-node-xchain-hub')
        expect(runCmd).to.include('--network xchain-node')
        expect(runCmd).to.include('-p 10000:10000')
    })

    it('publishes and binds the hub on HUB_PORT_OVERRIDE for a second co-located install', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.createFakeModule('xchain-hub')

        const original = Object.getOwnPropertyDescriptor(realConfig, 'HUB_PORT_OVERRIDE')
        Object.defineProperty(realConfig, 'HUB_PORT_OVERRIDE', {
            value: '10500', configurable: true, enumerable: true, writable: true
        })
        try {
            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-hub', null, null, null, true)
        } finally {
            Object.defineProperty(realConfig, 'HUB_PORT_OVERRIDE', original)
        }

        const runCmd = capture.findCommands(/docker run/)[0].command
        expect(runCmd).to.include('-p 10500:10500')
        expect(runCmd).to.not.include('10000:10000')
    })
})
