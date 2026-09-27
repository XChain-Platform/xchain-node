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

const { expect, makeStubs, loadOperations, registerLifecycleHooks } = require('../module_operations.test/helpers/harness')

describe('Node update data directory preflight', function () {
    let originalDataDir

    registerLifecycleHooks(() => {})

    beforeEach(function () {
        originalDataDir = process.env.XCHAIN_NODE_DATA_DIR
        delete process.env.XCHAIN_NODE_DATA_DIR
    })

    afterEach(function () {
        if (originalDataDir === undefined) delete process.env.XCHAIN_NODE_DATA_DIR
        else process.env.XCHAIN_NODE_DATA_DIR = originalDataDir
    })

    it('refuses a node update with no configured data directory before replacement begins', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)

        let error
        try {
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
        } catch (err) {
            error = err
        }

        expect(error).to.be.an('error')
        expect(error.message).to.include('XCHAIN_NODE_DATA_DIR is unset')
        expect(stubs.db.getModuleContainer.called).to.equal(false)
        expect(stubs.installModule.called).to.equal(false)
        expect(stubs.forceRemoveContainerByName.called).to.equal(false)
        expect(stubs.stopContainerByName.called).to.equal(false)
    })

    it('preflights the complete request before updating a service listed ahead of the node', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)

        let error
        try {
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder', 'node'] } })
        } catch (err) {
            error = err
        }

        expect(error).to.be.an('error')
        expect(stubs.db.getModuleContainer.called).to.equal(false)
        expect(stubs.installModule.called).to.equal(false)
    })

    it('updates the node when the data directory is explicitly configured', async function () {
        process.env.XCHAIN_NODE_DATA_DIR = '/srv/xchain/data'
        const stubs = makeStubs()
        const ops = loadOperations(stubs)

        const outcome = await ops.updateModules({ bitcoin: { mainnet: ['node'] } })

        expect(outcome.updated).to.deep.equal([
            { module: 'node', coin: 'bitcoin', network: 'mainnet' }
        ])
        expect(stubs.installModule.calledOnce).to.equal(true)
    })
})
