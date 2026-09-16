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
    // recreateModules
    // -------------------------------------------------------------------

    // A container freezes its env at `docker run`, so correcting a value it
    // carries means recreating it. Doing that through `update` also re-clones from
    // GitHub, which turns a credential repair into a version change on a live venue.

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('recreateModules()', function () {

        it('recreates from the current config while reusing the existing image', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(result.recreated).to.deep.equal([{ module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest' }])
            expect(stubs.buildAndUp.calledOnce).to.be.true
            const args = stubs.buildAndUp.firstCall.args
            expect(args.slice(0, 3)).to.deep.equal(['xchain-indexer', 'dogecoin', 'regtest'])
            expect(args[3]).to.equal('container-id-123')  // overwriteContainerId
            expect(args[6]).to.deep.equal({ reuseImage: true })
        })

        it('never re-clones or rebuilds through installModule', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.installModule.called).to.be.false
            expect(stubs.cloneGit.called).to.be.false
        })

        it('provisions the DB accounts only after every container is back on config values', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-decoder', 'xchain-indexer'] } })
            expect(stubs.setDatabaseParameters.calledOnce).to.be.true
            expect(stubs.buildAndUp.calledTwice).to.be.true
            expect(stubs.buildAndUp.secondCall.calledBefore(stubs.setDatabaseParameters.firstCall)).to.be.true
        })

        it('skips DB provisioning for a service that owns no DB account', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-encoder'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(stubs.setDatabaseParameters.called).to.be.false
            expect(stubs.setHubDatabaseParameters.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('recreateModules()', function () {

        // The recreated hub starts on the config store's HUB_DB_PASS. Without
        // rotating the live shared hub account to match, the verb that exists to
        // REPAIR credentials is the one that locks the hub out (ER_ACCESS_DENIED).
        it('rotates the shared hub DB account after recreating the hub', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ '': { '': ['xchain-hub'] } })
            expect(result.recreated).to.deep.equal([{ module: 'xchain-hub', coin: '', network: '' }])
            expect(stubs.setHubDatabaseParameters.calledOnce).to.be.true
            expect(stubs.buildAndUp.firstCall.calledBefore(stubs.setHubDatabaseParameters.firstCall)).to.be.true
            // The per-coin decoder/indexer provisioning is a different account set
            // and must not be dragged in by a hub-only recreate.
            expect(stubs.setDatabaseParameters.called).to.be.false
        })

        it('does not rotate the hub account when the hub was not recreated', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.setHubDatabaseParameters.called).to.be.false
        })

        // Registry DRIFT: the row is gone but the container is still on the host.
        // Recreating is right here, and is why the not-installed guard keys off a
        // positive docker probe rather than off the missing row alone.
        it('recreates a container the registry has lost rather than skipping it', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.probeContainerPresenceByName.resolves('exists')
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(stubs.buildAndUp.firstCall.args[3]).to.equal(null)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('recreateModules()', function () {

        // UNINSTALLED: no row and docker positively reports no container. Recreating
        // here hands back a service the operator tore down, built from the image tag
        // `uninstall` leaves behind, and then rotates the shared DB accounts for it.
        it('refuses to recreate a module docker positively reports gone', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.probeContainerPresenceByName.resolves('gone')
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await loadOperations(stubs).recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            } finally { warn.restore() }
            expect(stubs.buildAndUp.called).to.be.false
            expect(result.recreated).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest', reason: 'not-installed' }
            ])
            expect(stubs.setDatabaseParameters.called).to.be.false
            expect(stubs.probeContainerPresenceByName.calledWith('dogecoin-regtest-xchain-indexer')).to.be.true
        })

        // 'unknown' is a daemon hiccup, not an absence. Refusing on it would turn a
        // docker blip into a refusal to repair a live container's credentials.
        it('still recreates when the presence probe is inconclusive', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.probeContainerPresenceByName.resolves('unknown')
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(stubs.buildAndUp.firstCall.args[3]).to.equal(null)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('recreateModules()', function () {

        // A registered container never reaches the probe: one `docker inspect` per
        // venue on `recreate all` is worth paying only where the row is missing.
        it('does not probe docker when the registry has a container id', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.probeContainerPresenceByName.called).to.be.false
        })

        // `recreate all` fans out over every coin x network x service, so one bad
        // venue must not abort the sweep: the rest would go untouched behind a flat
        // "recreate failed" that hides which venues were already recreated.
        it('finishes the sweep past a failing venue and names every failure', async function () {
            const stubs = makeStubs()
            stubs.buildAndUp.onFirstCall().rejects(new Error('No local image tagged x to reuse'))
            const err = sinon.stub(console, 'error')
            try {
                await loadOperations(stubs).recreateModules({ dogecoin: { regtest: ['xchain-encoder', 'xchain-indexer'] } })
                expect.fail('a sweep with a failed venue must not resolve')
            } catch (e) {
                expect(e.message).to.match(/xchain-encoder \(dogecoin regtest\)/)
                expect(e.message).to.match(/No local image tagged/)
            } finally { err.restore() }
            expect(stubs.buildAndUp.calledTwice).to.be.true
            expect(stubs.buildAndUp.secondCall.args.slice(0, 3))
                .to.deep.equal(['xchain-indexer', 'dogecoin', 'regtest'])
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('recreateModules()', function () {

        // The venues that DID come back start on the config store's password, so
        // they still need their accounts rotated before the run reports failure.
        it('provisions the venues that came back before failing the run', async function () {
            const stubs = makeStubs()
            stubs.buildAndUp.onFirstCall().rejects(new Error('boom'))
            const err = sinon.stub(console, 'error')
            try {
                await loadOperations(stubs).recreateModules({ dogecoin: { regtest: ['xchain-encoder', 'xchain-indexer'] } })
                expect.fail('a sweep with a failed venue must not resolve')
            } catch { /* asserted above */ } finally { err.restore() }
            expect(stubs.setDatabaseParameters.calledOnce).to.be.true
        })

        it('refuses the modules whose containers are not built from the config map', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ dogecoin: { regtest: ['node', 'database'] } })
            expect(stubs.buildAndUp.called).to.be.false
            // Refusing every requested module must be REPORTED, not just printed:
            // the CLI turns an empty `recreated` list into a non-zero exit instead of
            // logging the refusal, returning true and exiting 0.
            expect(result.recreated).to.deep.equal([])
            expect(result.skipped.map(s => s.module)).to.deep.equal(['node', 'database'])
            expect(result.skipped.every(s => s.reason === 'not-recreatable')).to.be.true
        })

        it('still recreates the supported modules when the request also names an unsupported one', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ dogecoin: { regtest: ['node', 'xchain-indexer'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(result.recreated.map(r => r.module)).to.deep.equal(['xchain-indexer'])
            expect(result.skipped.map(s => s.module)).to.deep.equal(['node'])
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('recreateModules()', function () {

        it('propagates a failure instead of reporting success', async function () {
            const stubs = makeStubs()
            stubs.buildAndUp.rejects(new Error('No local image tagged x to reuse'))
            const ops = loadOperations(stubs)
            try {
                await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
                expect.fail('a failed recreate must not resolve')
            } catch (err) {
                expect(err.message).to.match(/No local image tagged/)
            }
            expect(stubs.setDatabaseParameters.called).to.be.false
        })
    })
})
