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

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // resetModules(): destructive-reset confirmation guard
    // -------------------------------------------------------------------

        describe('resetModules(): confirmation guard', function () {

        it('force=true skips the confirmation prompt entirely', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
            try {
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(stubs.stopContainer.called).to.be.true
            } finally {
                if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor)
                else delete process.stdin.isTTY
            }
        })

        it('refuses to reset on a non-interactive terminal without --yes/force', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
            try {
                let thrown = null
                try {
                    await ops.resetModules('node', 'bitcoin', 'mainnet', false)
                } catch (err) {
                    thrown = err
                }
                expect(thrown).to.not.be.null
                expect(thrown.message).to.match(/--yes/)
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.execFile.called).to.be.false
            } finally {
                if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor)
                else delete process.stdin.isTTY
            }
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // logModules: no containers case
    // -------------------------------------------------------------------

        describe('logModules(): no containers', function () {

        it('prints "No service was selected" when no containers found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null) // no containers
            const ops = loadOperations(stubs)
            const result = await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.logContainer.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // restartModules: error path
    // -------------------------------------------------------------------

        describe('restartModules(): error path', function () {

        it('continues after restartContainer error', async function () {
            const stubs = makeStubs()
            stubs.restartContainer.rejects(new Error('restart failed'))
            const ops = loadOperations(stubs)
            const result = await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(result).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // stopModules/startModules: skip when no container
    // -------------------------------------------------------------------

        describe('stopModules(): skip when no container', function () {

        it('skips when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.false
        })

        it('continues after stopContainer error', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.rejects(new Error('stop failed'))
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


        describe('startModules(): error path', function () {

        it('continues after startContainer error', async function () {
            const stubs = makeStubs()
            stubs.startContainer.rejects(new Error('start failed'))
            const ops = loadOperations(stubs)
            const result = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


        describe('execModules(): error path', function () {

        it('continues after execContainer error', async function () {
            const stubs = makeStubs()
            stubs.execContainer.rejects(new Error('exec failed'))
            const ops = loadOperations(stubs)
            const result = await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls')
            expect(result).to.be.true
        })

        it('skips when container ID is null', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls')
            expect(result).to.be.true
            expect(stubs.execContainer.called).to.be.false
        })
    })
})

// The post-reset bounce of decoder + indexer is the last thing reset does to them, so a
// restart failure swallowed there leaves a freshly wiped service stopped while reset exits 0.

// Run a joint decoder/indexer reset to completion and return its outcome, settled or thrown.
// `duringSettle` runs while the bounce waits out its 5s settle, after the start pass is done.
async function runBounceReset(stubs, { duringSettle = () => {} } = {}) {
    const ops = loadOperations(stubs)
    const clock = sinon.useFakeTimers()
    const warn = sinon.stub(console, 'warn')
    try {
        const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true, true)
            .then((value) => ({ value }), (error) => ({ error }))
        await clock.tickAsync(1000)
        duringSettle()
        await clock.tickAsync(20000)
        return await promise
    } finally {
        clock.restore()
        warn.restore()
    }
}

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules()', function () {
        describe('the post-reset decoder/indexer bounce', function () {

            it('reports a bounce restart that fails twice instead of returning success', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.restartContainer.rejects(new Error('docker restart: container failed to start'))
                const outcome = await runBounceReset(stubs)
                expect(outcome.error, 'reset must not resolve with a bounced service down').to.be.an('error')
                expect(outcome.error.message).to.match(/failed to restart/)
                expect(outcome.error.message).to.match(/post-reset restart failed \(docker restart: container failed to start\)/)
                // One try plus one retry per bounced module (decoder and indexer).
                expect(stubs.restartContainer.callCount).to.equal(4)
            })

            it('recovers silently when the retry succeeds', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.restartContainer.onCall(0).rejects(new Error('transient'))
                stubs.restartContainer.resolves(true)
                const outcome = await runBounceReset(stubs)
                expect(outcome.error).to.equal(undefined)
                expect(outcome.value).to.equal(true)
            })

            it('reports a registry read that fails at bounce time rather than skipping it as not installed', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                let bouncing = false
                stubs.db.getModuleContainerStrict.callsFake(async () => {
                    if (bouncing) throw new Error('ER_LOCK_WAIT_TIMEOUT')
                    return 'container-id-123'
                })
                const outcome = await runBounceReset(stubs, { duringSettle: () => { bouncing = true } })
                expect(stubs.startContainer.called, 'the start pass must finish before the flip').to.equal(true)
                expect(outcome.error).to.be.an('error')
                expect(outcome.error.message).to.match(/registry lookup failed before the post-reset bounce/)
                expect(stubs.restartContainer.called).to.equal(false)
            })
        })
    })
})
