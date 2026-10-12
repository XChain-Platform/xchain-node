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

const NODE_DATADIR = '/srv/xchain/data/node/bitcoin/mainnet'
const VOLUME = 'xchain-utxo-tracker-bitcoin-mainnet-data'

// The `docker run` wipes this reset issued, as the host side of each `-v <host>:/data` mount.
function wipeMounts(execFileStub) {
    return execFileStub.getCalls()
        .filter(c => Array.isArray(c.args[1]) && c.args[1][0] === 'run')
        .map(c => c.args[1][c.args[1].indexOf('-v') + 1].replace(/:\/data$/, ''))
}

// Run a forced reset with console.log captured, and hand back the result and what it printed.
async function resetCapturing(stubs, service) {
    const ops = loadOperations(stubs)
    const lines = []
    const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
    let result
    try {
        result = await ops.resetModules(service, 'bitcoin', 'mainnet', true)
    } finally {
        logStub.restore()
    }
    return { result, output: lines.join('\n') }
}

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules() wipe-image pre-flight', function () {

        it('refuses before stopping anything when the alpine image can be neither found nor pulled', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (args[0] === 'image' || args[0] === 'pull') return cb(new Error('dial tcp: lookup registry-1.docker.io: no such host'))
                cb(null, '', '')
            })
            const { result, output } = await resetCapturing(stubs, 'all')
            expect(result).to.be.false
            expect(stubs.stopContainer.called).to.be.false
            expect(wipeMounts(stubs.execFile)).to.have.length(0)
            expect(stubs.resetDatabases.called).to.be.false
            expect(output).to.include('cannot obtain the alpine image')
            expect(output).to.include('No data was touched.')
        })

        it('pulls the image when it is not cached and goes on to complete the reset', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (args[0] === 'image') return cb(new Error('Error: No such image: alpine'))
                cb(null, '', '')
            })
            const { result } = await resetCapturing(stubs, 'xchain-utxo-tracker')
            expect(result).to.be.true
            expect(stubs.execFile.getCalls().some(c => c.args[1][0] === 'pull' && c.args[1][1] === 'alpine')).to.be.true
            expect(wipeMounts(stubs.execFile)).to.include(VOLUME)
        })
    })
})

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules() a node data wipe that fails', function () {

        it('resolves false with every stopped service left down and the datadir named as possibly partial', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (args[0] === 'run' && args.join(' ').includes(NODE_DATADIR)) return cb(new Error('Error response from daemon: container exited'))
                cb(null, '', '')
            })
            const { result, output } = await resetCapturing(stubs, 'all')
            expect(result).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
            expect(stubs.startContainer.called).to.be.false
            expect(wipeMounts(stubs.execFile)).to.not.include(VOLUME)
            expect(output).to.include(`clearing node data at ${NODE_DATADIR} failed`)
            expect(output).to.include('may be PARTLY cleared')
            expect(output).to.include(`NOT touched: the Docker volume ${VOLUME}, the decoder/indexer databases.`)
            expect(output).to.match(/The stopped services are left down: .*xchain-indexer/)
            expect(output).to.not.include('No data was touched.')
        })

        it('says the datadir WAS cleared when a relocated wipe fails after it', async function () {
            const stubs = makeStubs()
            stubs.resolveBlocksDir.resolves('/mnt/blocks')
            stubs.fs.existsSync.returns(true)
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (args[0] === 'run' && args.join(' ').includes('/mnt/blocks/bitcoin/mainnet:')) return cb(new Error('permission denied'))
                cb(null, '', '')
            })
            const { result, output } = await resetCapturing(stubs, 'node')
            expect(result).to.be.false
            expect(stubs.startContainer.called).to.be.false
            expect(wipeMounts(stubs.execFile)).to.not.include('/mnt/blocks/bitcoin/mainnet-txindex')
            expect(output).to.include('clearing relocated node data at /mnt/blocks/bitcoin/mainnet failed (permission denied)')
            expect(output).to.include('The node data for this stack WAS already cleared')
            expect(output).to.include(NODE_DATADIR)
            expect(output).to.not.include('No data was touched.')
        })
    })
})
