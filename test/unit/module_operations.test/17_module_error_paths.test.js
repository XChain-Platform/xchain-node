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
            stubs.stopContainer.onFirstCall().rejects(new Error('restart failed'))
            const ops = loadOperations(stubs)
            const err = await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }).then(() => null, e => e)
            expect(stubs.stopContainer.callCount, 'the second module is still attempted').to.equal(2)
            expect(stubs.startContainer.callCount, 'a failed stop is never followed by a start').to.equal(1)
            expect(err, 'a failed restart must not resolve').to.be.an('error')
            expect(err.message).to.match(/restart failed for 1 module: xchain-encoder \(bitcoin mainnet\): restart failed/)
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
            stubs.db.getModuleContainerStrict.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.false
        })

        it('continues after stopContainer error', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.onFirstCall().rejects(new Error('stop failed'))
            const ops = loadOperations(stubs)
            const err = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }).then(() => null, e => e)
            expect(stubs.stopContainer.callCount, 'the second module is still attempted').to.equal(2)
            expect(err, 'a failed stop must not resolve').to.be.an('error')
            expect(err.message).to.match(/stop failed for 1 module: xchain-encoder \(bitcoin mainnet\): stop failed/)
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
            stubs.startContainer.onFirstCall().rejects(new Error('start failed'))
            const ops = loadOperations(stubs)
            const err = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }).then(() => null, e => e)
            expect(stubs.startContainer.callCount, 'the second module is still attempted').to.equal(2)
            expect(err, 'a failed start must not resolve').to.be.an('error')
            expect(err.message).to.match(/start failed for 1 module: xchain-encoder \(bitcoin mainnet\): start failed/)
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
                let startsBefore = 0
                const outcome = await runBounceReset(stubs, { duringSettle: () => {
                    startsBefore = stubs.startContainer.callCount
                    stubs.startContainer.rejects(new Error('docker start: container failed to start'))
                } })
                expect(outcome.error, 'reset must not resolve with a bounced service down').to.be.an('error')
                expect(outcome.error.message).to.match(/failed to restart/)
                expect(outcome.error.message).to.match(/post-reset restart failed \(xchain-\w+ was stopped but failed to start again \(docker start: container failed to start\)\)/)
                // One try plus one retry per bounced module (decoder and indexer).
                expect(stubs.startContainer.callCount - startsBefore).to.equal(4)
            })

            it('recovers silently when the retry succeeds', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                let stopsBefore = 0
                const outcome = await runBounceReset(stubs, { duringSettle: () => {
                    stopsBefore = stubs.stopContainer.callCount
                    stubs.stopContainer.onCall(stopsBefore).rejects(new Error('transient'))
                } })
                // The first bounce stop failed and was retried once; the second module bounced first time.
                expect(stubs.stopContainer.callCount - stopsBefore).to.equal(3)
                expect(outcome.error).to.equal(undefined)
                expect(outcome.value).to.equal(true)
            })

            it('reports a registry read that fails at bounce time rather than skipping it as not installed', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                let bouncing = false
                let stopsBefore = 0
                stubs.db.getModuleContainerStrict.callsFake(async () => {
                    if (bouncing) throw new Error('ER_LOCK_WAIT_TIMEOUT')
                    return 'container-id-123'
                })
                const outcome = await runBounceReset(stubs, { duringSettle: () => {
                    bouncing = true
                    stopsBefore = stubs.stopContainer.callCount
                } })
                expect(stubs.startContainer.called, 'the start pass must finish before the flip').to.equal(true)
                expect(outcome.error).to.be.an('error')
                expect(outcome.error.message).to.match(/registry lookup failed before the post-reset bounce/)
                expect(stubs.stopContainer.callCount, 'no bounce stop after a failed registry read').to.equal(stopsBefore)
            })
        })
    })
})

// start, stop and restart attempt every selected module and then fail together,
// so a runbook can trust the exit status the CLI derives from the rejection.
describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('start/stop/restart: failures are reported, not swallowed', function () {

        it('stop treats a container docker says is gone as stopped, not as a failure', async function () {
            const stubs = makeStubs()
            const gone = new Error('Error response from daemon: No such container: container-id-123')
            stubs.stopContainer.rejects(gone)
            const result = await loadOperations(stubs).stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })

        it('stop fails on a bare-string rejection, which is a failed stop rather than a miss', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.callsFake(() => Promise.reject('There was an error trying to stop the docker container (container-id-123)'))
            const err = await loadOperations(stubs).stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } }).then(() => null, e => e)
            expect(err).to.be.an('error')
            expect(err.failures).to.have.lengthOf(1)
            expect(err.failures[0].reason).to.match(/error trying to stop the docker container/)
        })

        it('fails on a registry read that errored instead of skipping the module as not installed', async function () {
            for (const op of ['startModules', 'stopModules', 'restartModules']) {
                const stubs = makeStubs()
                stubs.db.getModuleContainerStrict.rejects(new Error('pool closed'))
                const err = await loadOperations(stubs)[op]({ bitcoin: { mainnet: ['xchain-encoder'] } }).then(() => null, e => e)
                expect(err, op).to.be.an('error')
                expect(err.message, op).to.match(/registry lookup failed \(pool closed\)/)
                expect(stubs.db.getModuleContainer.called, op).to.be.false
            }
        })

        it('restart fails when the hub and explorer config refresh after it fails', async function () {
            const stubs = makeStubs()
            stubs.statusChanged.rejects(new Error('hub unreachable'))
            const err = await loadOperations(stubs).restartModules({ bitcoin: { mainnet: ['xchain-encoder'] } }).then(() => null, e => e)
            expect(stubs.stopContainer.calledOnce).to.be.true
            expect(stubs.startContainer.calledOnce).to.be.true
            expect(err.message).to.match(/restarted, but the hub and explorer config refresh failed \(hub unreachable\)/)
        })
    })
})
