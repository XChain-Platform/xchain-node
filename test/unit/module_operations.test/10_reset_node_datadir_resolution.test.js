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



        // The node datadir came from XCHAIN_NODE_DATA_DIR, and the wipe
        // was guarded on fs.existsSync of that path. A reset run from a shell
        // that never sourced the operator's profile therefore resolved a path
        // the stack has never used, the guard went silently false, and the run
        // wiped the decoder/indexer DBs, left the chain in place, and exited 0.
        // The missing "Clearing node data" line was the only tell.


            // The host side of every `docker run --rm -v <host>:/data` this
            // reset issued: what was actually wiped, in host paths.
            function wipedHostPaths(execFileStub) {
                return execFileStub.getCalls()
                    .filter(c => c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
                    .map(c => c.args[1][c.args[1].indexOf('-v') + 1])
            }
describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('node datadir resolution', function () {

            it('wipes the path the node container reports, not the env-derived one', async function () {
                const stubs = makeStubs()
                // Nothing at the env-derived path: the old guard's silent skip.
                stubs.fs.existsSync.returns(false)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(wipedHostPaths(stubs.execFile))
                    .to.include('/srv/xchain/data/node/bitcoin/mainnet:/data')
            })

            it('falls back to the configured datadir when the container reports no mount', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(true)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                const wiped = wipedHostPaths(stubs.execFile)
                expect(wiped.some(p => p.endsWith('/node/bitcoin/mainnet:/data'))).to.be.true
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
        describe('node datadir resolution', function () {

            it('refuses the whole reset when the datadir resolves to nothing', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(false)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                expect(result).to.be.false
                // Fails closed BEFORE anything is stopped or wiped: the whole
                // point is that the DBs must not go without the chain.
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(wipedHostPaths(stubs.execFile)).to.be.empty
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
        describe('node datadir resolution', function () {

            it('names the container, the configured path and the env var in the refusal', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(false)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...args) => lines.push(args.join(' ')))
                try {
                    await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                const output = lines.join('\n')
                expect(output).to.include('Aborted: cannot resolve the bitcoin mainnet node datadir')
                expect(output).to.include('No data was touched.')
                expect(output).to.include('bitcoin-mainnet-node')
                expect(output).to.include('XCHAIN_NODE_DATA_DIR')
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
        describe('node datadir resolution', function () {

            it('skips the node wipe out loud, and completes, when no node is installed', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(false)
                stubs.db.getModuleContainer.withArgs('node', 'bitcoin', 'mainnet').resolves(null)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...args) => lines.push(args.join(' ')))
                let result
                try {
                    result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.true
                expect(lines.join('\n')).to.include('no node data to clear')
                expect(wipedHostPaths(stubs.execFile)).to.be.empty
            })
        })
    })
})
