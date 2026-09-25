'use strict'

// GENERATED
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks } = require('./helpers/harness')

describe('moduleOperations updateModules(): partial update continuation', function () {
    registerLifecycleHooks(() => {})

    it('continues after reporting unrelated credential drift from a confirmed rebuild', async function () {
        const stubs = makeStubs()
        const refusal = new Error(
            'Refusing to rotate the bitcoin regtest MariaDB accounts: a running container uses another password'
        )
        refusal.code = 'DB_CREDENTIAL_DRIFT'
        stubs.db.getModuleContainer.onFirstCall().resolves('old-dogecoin-container')
        stubs.db.getModuleContainer.onSecondCall().resolves('new-dogecoin-container')
        stubs.db.getModuleContainer.onThirdCall().resolves('litecoin-container')
        stubs.installModule.onFirstCall().rejects(refusal)
        stubs.installModule.onSecondCall().resolves('new-litecoin-container')
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        let outcome
        try {
            outcome = await ops.updateModules({
                dogecoin: { regtest: ['xchain-indexer'] },
                litecoin: { regtest: ['xchain-encoder'] }
            })
        } finally { warn.restore() }

        expect(outcome.updated).to.deep.equal([
            { module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest' },
            { module: 'xchain-encoder', coin: 'litecoin', network: 'regtest' }
        ])
        expect(outcome.failed).to.deep.equal([{
            module: 'xchain-indexer',
            coin: 'bitcoin',
            network: 'regtest',
            reason: refusal.message
        }])
        expect(warn.calledWithMatch(/dogecoin regtest.*was rebuilt.*bitcoin regtest/)).to.be.true
        expect(stubs.installModule.callCount).to.equal(2)
    })

    it('does not infer a rebuild from an unrelated coin named in the error', async function () {
        const stubs = makeStubs()
        const refusal = new Error(
            'Refusing to rotate the bitcoin regtest MariaDB accounts: a running container uses another password'
        )
        refusal.code = 'DB_CREDENTIAL_DRIFT'
        stubs.installModule.rejects(refusal)
        const ops = loadOperations(stubs)

        let err
        try {
            await ops.updateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
        } catch (caught) {
            err = caught
        }

        expect(err).to.equal(refusal)
        expect(stubs.db.getModuleContainer.callCount).to.equal(2)
    })

    it('rethrows ordinary install failures without attempting later coins', async function () {
        const stubs = makeStubs()
        const failure = new Error('docker: no space left on device')
        stubs.installModule.rejects(failure)
        const ops = loadOperations(stubs)

        let err
        try {
            await ops.updateModules({
                bitcoin: { regtest: ['xchain-encoder'] },
                dogecoin: { regtest: ['xchain-encoder'] }
            })
        } catch (caught) {
            err = caught
        }

        expect(err).to.equal(failure)
        expect(stubs.installModule.calledOnce).to.be.true
    })

    it('fails closed when the credential refusal belongs to the requested coin', async function () {
        const stubs = makeStubs()
        const refusal = new Error(
            'Refusing to rotate the dogecoin regtest MariaDB accounts: a running container uses another password'
        )
        refusal.code = 'DB_CREDENTIAL_DRIFT'
        stubs.installModule.rejects(refusal)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')

        let err
        try {
            await ops.updateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
        } catch (caught) {
            err = caught
        } finally { warn.restore() }

        expect(err).to.equal(refusal)
        expect(stubs.db.getModuleContainer.calledOnce).to.be.true
    })
})
