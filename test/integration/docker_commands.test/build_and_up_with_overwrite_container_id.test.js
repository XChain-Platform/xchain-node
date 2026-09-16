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

// Overwrite (update) scenario
dockerSuite('buildAndUp with overwriteContainerId', function (fixture) {

    it('kills and removes old container before creating new one', async function () {
        const { env, capture, fakeContainerId, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', '')
        env.createFakeModule('xchain-encoder')

        const oldContainerId = fakeContainerId('o')
        const { ModuleService } = makeBuildAndUp()

        await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', oldContainerId, true)

        const killCmds = capture.findCommands(/docker kill/)
        expect(killCmds).to.have.length(1)
        expect(killCmds[0].command).to.include(oldContainerId)

        // Two `docker rm`s, not one: the explicit overwriteContainerId removal
        // above is id-keyed, plus buildAndUp also runs a name-keyed
        // forceRemoveContainerByName(containerPrefix) immediately before
        // `docker run --name`, to catch a leftover carcass the registry never
        // recorded (e.g. an interrupted prior run). Deliberate belt-and-suspenders
        // cleanup, not a duplicate call; see ModuleService.js's
        // "Name-keyed cleanup" comment (uuid:9533ee7a).
        const rmCmds = capture.findCommands(/docker rm/)
        expect(rmCmds).to.have.length(2)
        expect(rmCmds.some(c => c.command.includes(oldContainerId))).to.be.true
        expect(rmCmds.some(c => c.command.includes('xchain-node-bitcoin-mainnet-xchain-encoder'))).to.be.true

        const runCmds = capture.findCommands(/docker run/)
        expect(runCmds).to.have.length(1)
    })
})
