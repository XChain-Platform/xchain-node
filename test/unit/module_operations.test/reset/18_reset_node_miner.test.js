'use strict'

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks } = require('../helpers/harness')

function containerLookup(module) {
    if (module === 'node') return 'node-container'
    if (module === 'xchain-regtest-miner') return 'miner-container'
    return 'other-container'
}

describe('moduleOperations node reset miner lifecycle', function () {
    registerLifecycleHooks(() => {})

    it('stops and restarts the regtest miner after the node', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
        stubs.db.getModuleContainerStrict.callsFake(async (module) => containerLookup(module))
        const ops = loadOperations(stubs)

        expect(await ops.resetModules('node', 'bitcoin', 'regtest', true)).to.be.true

        expect(stubs.stopContainer.getCalls().map((call) => call.args[0])).to.deep.equal([
            'node-container',
            'miner-container',
        ])
        expect(stubs.startContainer.getCalls().map((call) => call.args[0])).to.deep.equal([
            'node-container',
            'miner-container',
        ])
    })

    it('does not touch the miner during a decoder-only reset', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
        stubs.db.getModuleContainerStrict.callsFake(async (module) =>
            module === 'xchain-indexer' ? null : containerLookup(module))
        const ops = loadOperations(stubs)
        const clock = sinon.useFakeTimers()
        const reset = ops.resetModules('xchain-decoder', 'bitcoin', 'regtest', true)
        await clock.tickAsync(6000)
        clock.restore()

        expect(await reset).to.be.true
        expect(stubs.stopContainer.neverCalledWith('miner-container')).to.be.true
        expect(stubs.startContainer.neverCalledWith('miner-container')).to.be.true
    })

    it('skips an absent miner without failing a node reset', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
        stubs.db.getModuleContainerStrict.callsFake(async (module) =>
            module === 'xchain-regtest-miner' ? null : containerLookup(module))
        const ops = loadOperations(stubs)

        expect(await ops.resetModules('node', 'bitcoin', 'mainnet', true)).to.be.true
        expect(stubs.stopContainer.calledOnceWith('node-container')).to.be.true
        expect(stubs.startContainer.calledOnceWith('node-container')).to.be.true
        expect(stubs.db.getModuleContainerStrict.neverCalledWith('xchain-regtest-miner')).to.be.true
    })
})
