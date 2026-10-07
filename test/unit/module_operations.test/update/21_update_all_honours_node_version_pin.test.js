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

// `update all` leaves a coin node running only when it already carries the
// daemon an update would install, and with XCHAIN_NODE_NODE_VERSION_<COIN> set
// that daemon is the pin, not the latest release.

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks } = require('../helpers/harness')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PIN_ENV = 'XCHAIN_NODE_NODE_VERSION_BITCOIN'

describe('moduleOperations', function () {
    let dataDir, previousDataDir
    beforeEach(function () {
        previousDataDir = process.env.XCHAIN_NODE_DATA_DIR
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-update-pin-'))
        process.env.XCHAIN_NODE_DATA_DIR = dataDir
    })
    afterEach(function () {
        delete process.env[PIN_ENV]
        try {
            fs.rmSync(dataDir, { recursive: true, force: true })
        } finally {
            if (previousDataDir === undefined) delete process.env.XCHAIN_NODE_DATA_DIR
            else process.env.XCHAIN_NODE_DATA_DIR = previousDataDir
        }
    })
    registerLifecycleHooks(() => {})

    describe('updateModules(): `all` against a daemon version pin', function () {

        it('leaves a coin node running when it carries the pinned daemon, though a newer release exists', async function () {
            process.env[PIN_ENV] = 'v27.0'
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '27.0\n' } } } })
            stubs.getRemoteModuleVersions = () => ({ 'node-bitcoin': { tag_name: 'v28.1' } })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0', { all: true })
            } finally { log.restore() }
            expect(stubs.installModule.calledWith('node')).to.be.false
            expect(result.skipped).to.deep.include({ module: 'node', coin: 'bitcoin', network: 'mainnet', reason: 'current' })
        })

        it('rebuilds a coin node running the latest release when the pin names another daemon', async function () {
            process.env[PIN_ENV] = 'v27.0'
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '28.1' } } } })
            stubs.getRemoteModuleVersions = () => ({ 'node-bitcoin': { tag_name: 'v28.1' } })
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0', { all: true })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })
    })
})
