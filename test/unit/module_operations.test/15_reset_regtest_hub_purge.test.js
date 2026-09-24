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



        // A regtest chain reset is a RE-GENESIS: the datadir goes and the chain
        // comes back from block 0. The hub's cross-chain rows are keyed by
        // `network` and a BTC-anchored snapshot_block and name no chain
        // INSTANCE, so without this purge the mirror hands every fresh indexer
        // the dead chain's finalized matches, which can never settle.

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the regtest re-genesis hub purge', function () {

            it('purges the hub cross-chain rows on a regtest node reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('node', 'bitcoin', 'regtest', true)).to.be.true
                expect(stubs.purgeHubCrossChainRows.calledOnceWithExactly('bitcoin', 'regtest')).to.be.true
                // While the stack is still down, so the rebuilt mirror never sees them.
                expect(stubs.purgeHubCrossChainRows.calledBefore(stubs.startContainer)).to.be.true
            })

            it('purges after the price fence on reset all', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'regtest', true)
                await clock.tickAsync(6000)
                clock.restore()
                expect(await promise).to.be.true
                expect(stubs.purgeHubCrossChainRows.calledOnce).to.be.true
                expect(stubs.clearHubPriceIngestWatermark.calledBefore(stubs.purgeHubCrossChainRows)).to.be.true
                expect(stubs.purgeHubCrossChainRows.calledBefore(stubs.startContainer)).to.be.true
            })
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the regtest re-genesis hub purge', function () {

            // An indexer-only reset is a REINDEX of a chain that is still there,
            // so its matches are still live and must not be purged.
            it('leaves the hub rows alone when the chain itself is not reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'regtest', true)
                await clock.tickAsync(6000)
                clock.restore()
                expect(await promise).to.be.true
                expect(stubs.purgeHubCrossChainRows.called).to.be.false
                // The fence still moves: that one belongs to the wiped indexer DB.
                expect(stubs.clearHubPriceIngestWatermark.called).to.be.true
            })

            it('never purges off regtest, where these rows are live federation history', async function () {
                for (const network of ['mainnet', 'testnet']) {
                    const stubs = makeStubs()
                    stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                    const ops = loadOperations(stubs)
                    expect(await ops.resetModules('node', 'bitcoin', network, true),
                        `expected the ${network} reset to succeed`).to.be.true
                    expect(stubs.purgeHubCrossChainRows.called,
                        `expected no purge on ${network}`).to.be.false
                }
            })
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the regtest re-genesis hub purge', function () {

            // The wipe already happened by this point, so a hub that cannot be
            // reached must not leave the stack down.
            it('does not abort the restart pass when the purge throws', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.purgeHubCrossChainRows.rejects(new Error('hub DB unreachable'))
                const ops = loadOperations(stubs)
                const warned = []
                const warn = sinon.stub(console, 'warn').callsFake((...a) => warned.push(a.join(' ')))
                let result
                try { result = await ops.resetModules('node', 'bitcoin', 'regtest', true) }
                finally { warn.restore() }
                expect(result).to.be.true
                expect(stubs.startContainer.called).to.be.true
                const text = warned.join('\n')
                expect(text).to.contain('hub DB unreachable')
                expect(text).to.contain('DELETE FROM cross_chain_matches')
                expect(text).to.contain('xchain-node restart xchain-hub')
            })
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the regtest re-genesis hub purge', function () {

            it('names the hub rows in the confirmation for a regtest node reset', async function () {
                const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
                Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
                const warned = []
                const warn = sinon.stub(console, 'warn').callsFake((...a) => warned.push(a.join(' ')))
                try {
                    const stubs = makeStubs()
                    stubs.readline.createInterface.returns({
                        question: (_q, cb) => cb('yes'),
                        close() {}
                    })
                    stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                    const ops = loadOperations(stubs)
                    expect(await ops.resetModules('node', 'bitcoin', 'regtest', false)).to.be.true

                    const mainnetStubs = makeStubs()
                    mainnetStubs.readline.createInterface.returns({
                        question: (_q, cb) => cb('yes'),
                        close() {}
                    })
                    mainnetStubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                    const mainnetOps = loadOperations(mainnetStubs)
                    expect(await mainnetOps.resetModules('node', 'bitcoin', 'mainnet', false)).to.be.true
                } finally {
                    warn.restore()
                    if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor)
                    else delete process.stdin.isTTY
                }
                const [regtestPrompt, mainnetPrompt] = warned
                    .filter(l => l.includes('Affected stores:'))
                expect(regtestPrompt).to.contain('hub cross-chain relic rows for this network')
                expect(regtestPrompt).to.contain('capability_snapshots')
                // Mainnet has no re-genesis path, so the line must not appear there.
                expect(mainnetPrompt).to.not.contain('hub cross-chain relic rows')
            })
        })
    })
})
