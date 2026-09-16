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
const { dockerSuite } = require('./docker_commands.test/support/fixture')

dockerSuite('xchain-encoder Docker run command', function (fixture) {

    it('includes correct hostname, network, port mapping, and env vars', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', '')
        env.createFakeModule('xchain-encoder')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)

        const buildCmds = capture.findCommands(/docker build/)
        expect(buildCmds).to.have.length(1)
        expect(buildCmds[0].command).to.include('-t xchain-node-bitcoin-mainnet-xchain-encoder')

        const runCmds = capture.findCommands(/docker run/)
        expect(runCmds).to.have.length(1)
        const runCmd = runCmds[0].command
        const runEnv = runCmds[0].options.env

        expect(runCmd).to.include('-d')
        expect(runCmd).to.include('--hostname xchain-node-bitcoin-mainnet-xchain-encoder')
        expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
        expect(runCmd).to.include('-t xchain-node-bitcoin-mainnet-xchain-encoder')
        // Port mapping
        expect(runCmd).to.include('-p 3003:3003')

        // Every container env var is passed by NAME on the docker run
        // command line; its VALUE travels only through execFile's `env`
        // option (3b0c5fa security fix), so the value must never appear
        // in argv. Assert both halves of that contract.
        expect(runCmd).to.include('--env NETWORK')
        expect(runCmd).to.include('--env NODE_PORT')
        expect(runCmd).to.include('--env ENCODER_API_PORT')
        expect(runCmd).to.include('--env NODE_URL')
        // NETWORK is coin-prefixed ("bitcoin-mainnet") for encoder/decoder/
        // utxo-tracker (d7a4a4f, predates the argv fix): those modules
        // resolve their bitcoinjs network via CryptoNetworks, which keys
        // on the coin-prefixed name. The bare network alone would derive
        // mainnet-versioned addresses on every non-mainnet install.
        expect(runCmd).to.not.include('NETWORK=bitcoin-mainnet')
        expect(runCmd).to.not.include('NODE_PORT=8332')
        expect(runCmd).to.not.include('ENCODER_API_PORT=3003')
        expect(runCmd).to.not.include('NODE_URL=node')
        expect(runEnv.NETWORK).to.equal('bitcoin-mainnet')
        expect(runEnv.NODE_PORT).to.equal('8332')
        expect(runEnv.ENCODER_API_PORT).to.equal('3003')
        expect(runEnv.NODE_URL).to.equal('node')
    })
})

dockerSuite('xchain-encoder Docker run command', function (fixture) {

    it('uses testnet port when network is testnet', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-testnet', '')
        env.createFakeModule('xchain-encoder')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'testnet', null, true)

        const runEntry = capture.findCommands(/docker run/)[0]
        const runCmd = runEntry.command
        expect(runCmd).to.include('--env NODE_PORT')
        expect(runCmd).to.include('--env NETWORK')
        expect(runCmd).to.not.include('NODE_PORT=18332')
        expect(runCmd).to.not.include('NETWORK=bitcoin-testnet')
        expect(runEntry.options.env.NODE_PORT).to.equal('18332')
        // Coin-prefixed for encoder (d7a4a4f); see the mainnet case above.
        expect(runEntry.options.env.NETWORK).to.equal('bitcoin-testnet')
    })
})

dockerSuite('xchain-encoder Docker run command', function (fixture) {

    it('propagates config file overrides into Docker env vars', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', 'ENCODER_API_PORT=4003\nENCODER_PORT=4003\n')
        env.createFakeModule('xchain-encoder')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)

        const runEntry = capture.findCommands(/docker run/)[0]
        const runCmd = runEntry.command
        expect(runCmd).to.include('--env ENCODER_API_PORT')
        expect(runCmd).to.not.include('ENCODER_API_PORT=4003')
        expect(runEntry.options.env.ENCODER_API_PORT).to.equal('4003')
        // Port mappings are not secrets and stay literal in argv.
        expect(runCmd).to.include('-p 4003:4003')
    })
})
