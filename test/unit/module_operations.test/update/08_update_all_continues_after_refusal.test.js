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

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks } = require('../helpers/harness')

describe('moduleOperations updateModules(): a guard refusal under `all`', function () {
    registerLifecycleHooks(() => {})

    const services = {
        '': { '': ['xchain-hub'] },
        bitcoin: { regtest: ['xchain-indexer', 'xchain-encoder'] }
    }

    function refuseFirst(stubs, message) {
        stubs.assertHubNotBehind.onFirstCall().rejects(new Error(message))
    }

    it('records the refused service as failed and still updates the rest', async function () {
        const stubs = makeStubs()
        refuseFirst(stubs, 'update refused: xchain-hub requires a newer hub')
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        let outcome
        try {
            outcome = await ops.updateModules(services, null, { all: true })
        } finally { warn.restore() }

        expect(outcome.failed).to.have.length(1)
        expect(outcome.failed[0]).to.include({ module: 'xchain-hub', coin: '', network: '' })
        expect(outcome.failed[0].reason).to.match(/update refused/)
        expect(outcome.updated.map(u => u.module)).to.deep.equal(['xchain-sync', 'xchain-indexer', 'xchain-encoder'])
        expect(stubs.installModule.callCount).to.equal(3)
    })

    it('records a migration refusal the same way', async function () {
        const stubs = makeStubs()
        stubs.assertRequiredMigrationsApplied.onFirstCall().rejects(new Error('migrations pending'))
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        let outcome
        try {
            outcome = await ops.updateModules(services, null, { all: true })
        } finally { warn.restore() }

        expect(outcome.failed.map(f => f.module)).to.deep.equal(['xchain-hub'])
        expect(outcome.updated).to.have.length(3)
    })

    it('still stops a targeted update at the first refusal', async function () {
        const stubs = makeStubs()
        refuseFirst(stubs, 'update refused: xchain-indexer requires a newer hub')
        const ops = loadOperations(stubs)
        let err
        try {
            await ops.updateModules({ bitcoin: { regtest: ['xchain-indexer', 'xchain-encoder'] } })
        } catch (caught) { err = caught }

        expect(err).to.be.an('error')
        expect(err.message).to.match(/update refused/)
        expect(stubs.installModule.callCount).to.equal(0)
    })
})
