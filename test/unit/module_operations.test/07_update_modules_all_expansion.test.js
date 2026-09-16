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

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks, requireFromUnit } = require('./helpers/harness')



    // -------------------------------------------------------------------
    // updateModules: `all` includes the shared services, hub first
    // -------------------------------------------------------------------



        function servicesFromAll() {
            return requireFromUnit('../../src/services/config_service').filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        }
describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): the `all` expansion', function () {

        it('updates the hub, then sync, then the explorer, before any coin stack', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { warn.restore() }
            const order = stubs.installModule.getCalls().map(c => c.args[0])
            expect(order[0]).to.equal('xchain-hub')
            expect(order[1]).to.equal('xchain-sync')
            expect(order[2]).to.equal('xchain-explorer')
            expect(order.indexOf('xchain-indexer')).to.be.greaterThan(2)
            // Shared services are addressed under the empty coin/network key.
            expect(stubs.installModule.firstCall.args.slice(1, 3)).to.deep.equal(['', ''])
        })

        it('re-runs the validator repair before rebuilding the hub on an initialized validator', async function () {
            const stubs = makeStubs()
            // Required HERE, not at the top of the file. proxyquire is a
            // process-wide singleton and a suite that ran earlier may have
            // turned cache preservation off, which leaves a file-level binding
            // pointing at a module instance nothing under test still uses.
            const validator = requireFromUnit('../../src/services/validator_service')
            const isInitialized = sinon.stub(validator, 'isInitialized').returns(true)
            const initValidator = sinon.stub(validator, 'initValidator').resolves({ pubkey: 'ab' })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { log.restore(); warn.restore(); isInitialized.restore(); initValidator.restore() }
            expect(initValidator.calledOnce).to.equal(true)
            expect(initValidator.firstCall.args[0]).to.deep.equal({})
            expect(initValidator.calledBefore(stubs.installModule)).to.equal(true)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): the `all` expansion', function () {

        it('does not touch validator config on a node that is not a validator, or when the hub is out of scope', async function () {
            const stubs = makeStubs()
            // Required HERE, not at the top of the file. proxyquire is a
            // process-wide singleton and a suite that ran earlier may have
            // turned cache preservation off, which leaves a file-level binding
            // pointing at a module instance nothing under test still uses.
            const validator = requireFromUnit('../../src/services/validator_service')
            const isInitialized = sinon.stub(validator, 'isInitialized').returns(false)
            const initValidator = sinon.stub(validator, 'initValidator').resolves()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
                isInitialized.returns(true)
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            } finally { warn.restore(); isInitialized.restore(); initValidator.restore() }
            expect(initValidator.called).to.equal(false)
        })

        it('continues the hub update when the validator repair fails, and says so', async function () {
            const stubs = makeStubs()
            // Required HERE, not at the top of the file. proxyquire is a
            // process-wide singleton and a suite that ran earlier may have
            // turned cache preservation off, which leaves a file-level binding
            // pointing at a module instance nothing under test still uses.
            const validator = requireFromUnit('../../src/services/validator_service')
            const isInitialized = sinon.stub(validator, 'isInitialized').returns(true)
            const initValidator = sinon.stub(validator, 'initValidator').rejects(new Error('wallets.env unreadable'))
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { log.restore(); warn.restore(); isInitialized.restore(); initValidator.restore() }
            expect(warn.calledWithMatch(/wallets\.env unreadable/)).to.equal(true)
            expect(result.updated.map(u => u.module)).to.include('xchain-hub')
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): the `all` expansion', function () {

        it('leaves the hub and sync out of a targeted update, as before', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            expect(stubs.installModule.getCalls().map(c => c.args[0])).to.deep.equal(['xchain-encoder'])
        })

        it('reports a shared service that is not installed as skipped, not as a failure', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.callsFake(async (module) => module === 'xchain-sync' ? null : 'container-id-123')
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { warn.restore(); log.restore() }
            expect(result.skipped.find(s => s.module === 'xchain-sync').reason).to.equal('not-installed')
            expect(result.updated.map(u => u.module)).to.include('xchain-hub')
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): the `all` expansion', function () {

        // A validator is a hub and nothing else; `all` still expands to every
        // coin service, and one warning per absent service buried the two lines
        // that mattered.
        it('collapses the absent services into one line under `all`, and keeps the per-service warning for a targeted update', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.callsFake(async (module) => module === 'xchain-hub' ? 'container-id-123' : null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { warn.restore(); log.restore() }
            const absent = result.skipped.filter(s => s.reason === 'not-installed').length
            expect(absent).to.be.greaterThan(1)
            expect(warn.getCalls().filter(c => /no registered container/.test(c.args[0]))).to.have.lengthOf(0)
            expect(log.getCalls().filter(c => new RegExp(`skipped ${absent} services not installed`).test(c.args[0]))).to.have.lengthOf(1)

            const warn2 = sinon.stub(console, 'warn')
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            } finally { warn2.restore() }
            expect(warn2.calledWithMatch(/xchain-encoder \(bitcoin mainnet\) has no registered container/)).to.equal(true)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): the `all` expansion', function () {

        // A rebuild of a coin node that was already at the pinned daemon
        // version restarted a healthy daemon and broke a relocated datadir's mounts.
        it('leaves a coin node running when it already carries the pinned daemon version', async function () {
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '28.1\n' } } } })
            stubs.getRemoteModuleVersions = () => ({ 'node-bitcoin': { tag_name: 'v28.1' } })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['node', 'xchain-encoder'] } }, 'v0.11.0', { all: true })
            } finally { log.restore() }
            expect(stubs.installModule.calledWith('node')).to.be.false
            expect(result.skipped).to.deep.include({ module: 'node', coin: 'bitcoin', network: 'mainnet', reason: 'current' })
            expect(result.updated.map(u => u.module)).to.include('xchain-encoder')
            expect(result.updated.map(u => u.module)).to.not.include('node')
        })

        it('still rebuilds a coin node that is behind the pinned daemon version', async function () {
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '27.0' } } } })
            stubs.getRemoteModuleVersions = () => ({ 'node-bitcoin': { tag_name: 'v28.1' } })
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0', { all: true })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('rebuilds a coin node whose pinned version it cannot determine', async function () {
            // Any doubt answers "rebuild": the operator could always get one.
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '28.1' } } } })
            const versions = requireFromUnit('../../src/services/version_service')
            const check = sinon.stub(versions, 'checkRemoteNodeVersion').rejects(new Error('rate limited'))
            const ops = loadOperations(stubs)
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0', { all: true })
            } finally { check.restore() }
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): the `all` expansion', function () {

        it('does not install a coin node that is absent under `all`, but still recreates one on a targeted update', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.callsFake(async (module) => module === 'xchain-hub' ? 'container-id-123' : null)
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { log.restore(); warn.restore() }
            expect(stubs.installModule.calledWith('node')).to.equal(false)
            expect(result.skipped).to.deep.include({ module: 'node', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' })

            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0')
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.equal(true)
        })

        it('rebuilds a coin node on a TARGETED update whatever version it runs', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0')
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })
    })
})
