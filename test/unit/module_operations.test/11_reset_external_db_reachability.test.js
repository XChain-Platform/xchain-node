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



        // A pre-wipe MariaDB guard that is docker-mode only lets an
        // EXTERNAL_DB reset reached the database for the first time at
        // resetDatabases: after the stop loop, the datadir wipe and the tracker
        // volume wipe, and before the restart pass. An unreachable host (or a
        // partial XCHAIN_NODE_EXTERNAL_DB_* env) therefore left the operator
        // with the chain destroyed, the databases untouched and every service
        // down.


            // Host side of every `docker run --rm -v <host>:/data` this reset issued.
            function wipedPaths(execFileStub) {
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
        describe('EXTERNAL_DB pre-wipe reachability guard', function () {

            it('aborts before anything is stopped or wiped when the external DB is unreachable', async function () {
                const stubs = makeStubs()
                stubs.pingExternalDatabase.resolves({
                    ok: false, host: 'db.example', port: 3306, error: 'connect ECONNREFUSED'
                })
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...args) => lines.push(args.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(wipedPaths(stubs.execFile)).to.be.empty
                const output = lines.join('\n')
                expect(output).to.include('cannot reach the external MariaDB at db.example:3306')
                expect(output).to.include('connect ECONNREFUSED')
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
        describe('EXTERNAL_DB pre-wipe reachability guard', function () {

            it('aborts the same way when the external config cannot be resolved', async function () {
                const stubs = makeStubs()
                // getExternalDbConfig throws on a partial env with no TTY; the
                // probe reports that instead of unwinding past the restart pass.
                stubs.pingExternalDatabase.resolves({
                    ok: false, host: null, port: null, error: 'External-DB connection details are needed'
                })
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const logStub = sinon.stub(console, 'log')
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.stopContainer.called).to.be.false
                expect(wipedPaths(stubs.execFile)).to.be.empty
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
        describe('EXTERNAL_DB pre-wipe reachability guard', function () {

            it('proceeds to the reset when the external DB answers', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()
                const result = await promise
                expect(result).to.be.true
                expect(stubs.pingExternalDatabase.calledOnce).to.be.true
                expect(stubs.resetDatabases.called).to.be.true
                // The container lookup is the docker-mode branch and must not run here.
                expect(stubs.getDatabaseContainerId.called).to.be.false
            })

            it('does not probe the external DB when no database is being reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(stubs.pingExternalDatabase.called).to.be.false
            })
        })
    })
})
