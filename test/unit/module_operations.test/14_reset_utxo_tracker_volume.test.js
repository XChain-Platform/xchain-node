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



        // The tracker volume wipe returns silently for every failure: missing
        // volumes are treated as "not existing". A permission error, unreachable
        // daemon, or failed alpine pull leaves stale tracker data in place while
        // resetDatabases re-genesises the decoder and indexer around it.


            const VOLUME = 'xchain-utxo-tracker-bitcoin-mainnet-data'

            function volumeWipeRan(execFileStub) {
                return execFileStub.getCalls().some(c =>
                    c.args[1][0] === 'run' && c.args[1].join(' ').includes(VOLUME))
            }
describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the utxo-tracker volume wipe', function () {

            it('refuses the reset when the volume presence cannot be determined', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') {
                        return cb(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'))
                    }
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(volumeWipeRan(stubs.execFile)).to.be.false
                const output = lines.join('\n')
                expect(output).to.include(`cannot determine whether the Docker volume ${VOLUME} exists`)
                expect(output).to.include('No data was touched.')
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
        describe('the utxo-tracker volume wipe', function () {

            // Docker SAYING "no such volume" is the only thing that means absent.
            it('treats docker\'s own no-such-volume as absence and completes', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') return cb(new Error(`Error: No such volume: ${VOLUME}`))
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(volumeWipeRan(stubs.execFile)).to.be.false
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
        describe('the utxo-tracker volume wipe', function () {

            it('aborts and restores the stack when the wipe fails with nothing else touched', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') return cb(null, '', '')
                    if (args.join(' ').includes(VOLUME)) return cb(new Error('permission denied'))
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                const output = lines.join('\n')
                expect(output).to.include(`clearing the Docker volume ${VOLUME} failed`)
                expect(output).to.include('permission denied')
                expect(output).to.include('No data was touched.')
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
        describe('the utxo-tracker volume wipe', function () {

            // On `reset all` the node datadir is already gone by the time the
            // volume wipe runs, so the abort must not claim otherwise, must not
            // let the decoder/indexer databases go, and must not restart services
            // over a half-reset stack.
            it('refuses to drop the databases after a failed wipe on reset all', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') return cb(null, '', '')
                    if (args.join(' ').includes(VOLUME)) return cb(new Error('permission denied'))
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(stubs.startContainer.called).to.be.false
                const output = lines.join('\n')
                expect(output).to.include('The node data for this stack WAS already cleared')
                expect(output).to.not.include('No data was touched.')
            })
        })
    })
})
