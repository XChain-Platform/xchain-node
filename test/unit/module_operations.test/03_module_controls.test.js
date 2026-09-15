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
    // uninstallModules
    // -------------------------------------------------------------------


describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('uninstallModules()', function () {

        it('calls uninstallModule for each module', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        // Continuing past a failed module is deliberate: an operator tearing a
        // stack down wants the rest gone. Reporting SUCCESS afterwards is not:
        // `uninstall all` printed a clean teardown with containers still running.
        it('continues on error for individual modules, then fails the batch', async function () {
            const stubs = makeStubs()
            stubs.uninstallModule.onFirstCall().rejects(new Error('fail'))
            stubs.uninstallModule.onSecondCall().resolves(true)
            const ops = loadOperations(stubs)
            let thrown = null
            try {
                await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            } catch (err) { thrown = err }
            expect(thrown, 'a failed uninstall must not resolve').to.not.equal(null)
            expect(thrown.message).to.match(/uninstall failed for 1 module: xchain-encoder/)
            expect(stubs.uninstallModule.callCount).to.equal(2)
            expect(thrown.uninstalled.map(u => u.module)).to.deep.equal(['xchain-decoder'])
        })

        it('rejects when all modules fail, naming every one of them', async function () {
            const stubs = makeStubs()
            stubs.uninstallModule.rejects(new Error('fail'))
            const ops = loadOperations(stubs)
            let thrown = null
            try {
                await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            } catch (err) { thrown = err }
            expect(thrown).to.not.equal(null)
            expect(thrown.message).to.match(/uninstall failed for 2 modules/)
            expect(thrown.message).to.include('xchain-encoder')
            expect(thrown.message).to.include('xchain-decoder')
            expect(thrown.failures).to.have.lengthOf(2)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('uninstallModules()', function () {

        it('reports what it removed when every module succeeds', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.uninstalled).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // startModules
    // -------------------------------------------------------------------

        describe('startModules()', function () {

        it('looks up container ID and calls startContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.db.getModuleContainer.calledOnce).to.be.true
            expect(stubs.startContainer.calledWith('container-id-123')).to.be.true
        })

        it('skips module when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.startContainer.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // stopModules
    // -------------------------------------------------------------------

        describe('stopModules()', function () {

        it('looks up the container id and stops it with the service budget, not a bare docker stop', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.stopContainerByName.calledWith('container-id-123', 30)).to.be.true
            expect(stubs.stopContainer.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // restartModules
    // -------------------------------------------------------------------

        describe('restartModules()', function () {

        it('calls restartContainer and statusChanged', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.restartContainer.calledWith('container-id-123')).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // execModules
    // -------------------------------------------------------------------

        describe('execModules()', function () {

        it('passes command to execContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls -la')
            expect(stubs.execContainer.calledWith('container-id-123', ['ls', '-la'])).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // clearDecoderReorgHalt
    // -------------------------------------------------------------------

        describe('clearDecoderReorgHalt()', function () {
        const REASON = 'BTC mainnet decoder, no dispensers exist yet, block range intact'

        it('runs the decoder\'s own clear script inside the decoder container with the reason', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const ok = await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON })
            expect(ok).to.be.true
            expect(stubs.db.getModuleContainer.calledWith('xchain-decoder', 'bitcoin', 'mainnet')).to.be.true
            expect(stubs.execContainer.calledWith('container-id-123',
                ['node', 'src/clear-reorg-halt.js', '--reason', REASON])).to.be.true
        })

        it('passes --force and --dry-run through', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON, force: true, dryRun: true })
            expect(stubs.execContainer.firstCall.args[1]).to.deep.equal(
                ['node', 'src/clear-reorg-halt.js', '--reason', REASON, '--force', '--dry-run'])
        })

        it('refuses a trivial reason without touching any container', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: 'short' })).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })
    })
})



    // Same title, second block: keeps each describe callback under the 60-line limit.

        const REASON = 'BTC mainnet decoder, no dispensers exist yet, block range intact'
describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('clearDecoderReorgHalt()', function () {

        it('runs a dry run without a reason and passes no --reason', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const ok = await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { dryRun: true })
            expect(ok).to.be.true
            expect(stubs.execContainer.firstCall.args[1]).to.deep.equal(
                ['node', 'src/clear-reorg-halt.js', '--dry-run'])
        })

        it('refuses a real clear with no reason at all without touching any container', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, {})).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })

        it('reports false when the script refuses (non-zero exit) and prints its text', async function () {
            const stubs = makeStubs()
            stubs.execContainer.rejects(Object.assign(new Error('exit 4'), { stderr: 'clear-reorg-halt: REFUSED. dispenser state' }))
            const ops = loadOperations(stubs)
            const logged = []
            const orig = console.log
            console.log = (l) => logged.push(String(l))
            let ok
            try { ok = await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON }) }
            finally { console.log = orig }
            expect(ok).to.be.false
            expect(logged.some(l => /REFUSED/.test(l))).to.be.true
        })

        it('reports false when no decoder container is installed for the target', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON })).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('clearDecoderReorgHalt()', function () {

        it('ignores non-decoder modules in the list', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-encoder'] } }, { reason: REASON })).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })
    })
})
