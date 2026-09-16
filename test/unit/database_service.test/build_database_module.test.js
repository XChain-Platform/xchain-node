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

const { sinon, expect, VALID_CONTAINER_ID, fakeSpawn, mariadbAttempts, makeStubs, loadDatabaseService } = require('./helpers/harness')


// Locate the `docker run -d ...` argv array among the execFileAsync calls.
function findDockerRunArgs(execFileAsync) {
    const call = execFileAsync.getCalls().find(c =>
        c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
    return call ? call.args[1] : null
}

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {

        it('skips installation when database already exists and connects to network', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.calledOnce).to.be.true
        })

        it('fails fast with an actionable error when the existing DB container is not running', async function () {
            // A stopped/exited MariaDB container must not be treated as installed:
            // otherwise the readiness probe burns ~100s of retries before a
            // misleading abort. It must also NOT be auto-started or recreated.
            const stubs = makeStubs({
                getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'exited' } })
            })
            const ds = loadDatabaseService(stubs)
            let threw = null
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.match(/exists but is exited/)
            expect(threw.message).to.match(/docker start/)
            // No network mutation and no recreate attempt on a stopped container.
            expect(stubs.addContainerToNetwork.called).to.be.false
        })

        it('installs mariadb when no existing database found', async function () {
            const stubs = makeStubs()
            // First execFileAsync call is `docker inspect` inside getDatabaseContainerId()
            // (called by checkIfDatabaseModuleExists). Rejecting it makes the check
            // return null → buildDatabaseModule enters the install branch.
            // Subsequent calls (docker pull, tag, run) resolve with a valid container ID.
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
            expect(stubs.execFileAsync.called).to.be.true
        })
        })
})

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {


        // uuid:8a3e5182. The install branch is entered when checkIfDatabaseModuleExists
        // returns null, and that helper swallows EVERY error and also answers null on
        // any inspect output it cannot parse. So "we are installing" is not evidence
        // the container is absent, while the force-remove that follows is `docker rm -f`
        // against the stack's only persistent data store. These pin that the delete now
        // needs docker's own "no such container", not merely a falsy lookup.
        for (const presence of ['exists', 'unknown']) {
            it(`refuses to force-remove the MariaDB container when the probe says '${presence}'`, async function () {
                const stubs = makeStubs()
                stubs.probeContainerPresenceByName = sinon.stub().resolves(presence)
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)

                let threw = null
                try {
                    await ds.buildDatabaseModule('bitcoin', 'mainnet')
                } catch (err) { threw = err }

                expect(threw, 'an ambiguous probe must abort, not delete').to.be.an.instanceOf(Error)
                expect(threw.message).to.include(presence)
                expect(threw.message).to.include('xchain-node-database')
                expect(stubs.forceRemoveContainerByName.called, 'docker rm -f must not run').to.be.false
                expect(findDockerRunArgs(stubs.execFileAsync), 'docker run must not run').to.be.null
            })
        }

        it('force-removes only after docker positively reports the container gone', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')

            expect(stubs.probeContainerPresenceByName.calledWith('xchain-node-database')).to.be.true
            expect(stubs.forceRemoveContainerByName.calledOnce).to.be.true
            expect(findDockerRunArgs(stubs.execFileAsync)).to.not.be.null
        })
        })
})

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {

        it('throws instead of returning undefined when docker run output is not a 64-hex id', async function () {
            // uuid:fb0c275d: a mismatched id (e.g. a warning line ahead of the id)
            // means the container IS running but unregistered; falling through
            // silently would orphan it and cause a duplicate on the next run.
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: 'Warning: some notice\nnot-a-valid-id\n' })
            const ds = loadDatabaseService(stubs)
            let threw = null
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
            } catch (err) { threw = err }
            expect(threw).to.not.be.null
            expect(String(threw)).to.include('Unexpected docker run output')
        })

        it('runs the multi-stack host-port pre-flight before docker run', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')

            expect(stubs.assertNoHostPortConflicts.calledOnce).to.be.true
            const [portArgs, selfName] = stubs.assertNoHostPortConflicts.firstCall.args
            // -p spec binds the DB host port to container 3306, scoped to the DB container name.
            expect(portArgs).to.include('-p')
            expect(portArgs.some(a => /:3306$/.test(a))).to.be.true
            expect(selfName).to.equal('xchain-node-database')
        })

        it('aborts the install (no docker run) when a host-port conflict is detected', async function () {
            const stubs = makeStubs({
                assertNoHostPortConflicts: sinon.stub().rejects(new Error('Host port conflict: host port 13306 is already published by: other-stack-database'))
            })
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            let threw = null
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('Host port conflict')
            // The guard runs after pull/tag but before run, so `docker run` must NOT fire.
            expect(findDockerRunArgs(stubs.execFileAsync)).to.be.null
        })
        })
})

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {


        // Security regression: the MariaDB root password must reach the container
        // via docker's OWN environment (bare `--env NAME` + execFile { env }), and
        // must NEVER appear in the docker argv. If it did, a failed `docker run`
        // would reject with the secret embedded in err.cmd/err.message, which
        // upstream error logging (precheck's console.log(err)) would print.
        it('passes MYSQL_ROOT_PASSWORD via docker env, never in the argv', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')

            // The enquirer Password prompt is stubbed to resolve 'rootpass'.
            const ROOT_PW = 'rootpass'
            const runCall = stubs.execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
            expect(runCall, 'docker run call not found').to.not.be.undefined

            const runArgs = runCall.args[1]
            const runOpts = runCall.args[2] || {}

            // 1) The secret must not appear anywhere in the command line.
            expect(runArgs.some(a => String(a).includes(ROOT_PW)), 'secret leaked into docker argv').to.be.false
            expect(runArgs.some(a => /^MYSQL_ROOT_PASSWORD=/.test(String(a))), 'inline --env NAME=value leaks the secret').to.be.false
            // 2) The bare env name is forwarded so docker reads it from its env.
            expect(runArgs).to.include('MYSQL_ROOT_PASSWORD')
            // 3) The value is supplied through the child process environment.
            expect(runOpts.env, 'docker run env not set').to.be.an('object')
            expect(runOpts.env.MYSQL_ROOT_PASSWORD).to.equal(ROOT_PW)
        })
        })
})

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {


        // Container-health visibility (#3876). The DB container carried no
        // --health-* flags at all, so a stalled-but-alive mariadbd read healthy to
        // `docker ps` and to every tool that inspects container health, while
        // --restart unless-stopped only ever fires on process exit.
        it('gives the DB container a health probe so a stalled mariadbd is visible', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')

            const runArgs = findDockerRunArgs(stubs.execFileAsync)
            expect(runArgs, 'docker run call not found').to.not.be.null
            const cmdIdx = runArgs.indexOf('--health-cmd')
            expect(cmdIdx, 'no --health-cmd on the DB container').to.be.greaterThan(-1)
            // The image ships /usr/local/bin/healthcheck.sh (verified on mariadb:10.11).
            expect(String(runArgs[cmdIdx + 1])).to.include('healthcheck.sh')
            expect(runArgs).to.include('--health-interval')
            expect(runArgs).to.include('--health-start-period')
            // The DB side of the cross-file window invariant: the hub and explorer
            // descriptors take the same constant because their probes SELECT 1 against
            // THIS container. Pin the emitted value, not just the flag, because no
            // other guard reads this arg and a literal put back here would drift alone.
            const spIdx = runArgs.indexOf('--health-start-period')
            expect(String(runArgs[spIdx + 1]),
                'the DB start period must stay DEPENDENCY_HEALTH_START_PERIOD: the hub and ' +
                'explorer windows are derived from it and would silently go narrow'
            ).to.equal(require('../../../src/config').DEPENDENCY_HEALTH_START_PERIOD)
        })


        // The probe is visibility ONLY. AutohealService restarts a container only
        // when its module carries a SERVICE_HEALTHCHECK descriptor with
        // autoheal:true, and MariaDB deliberately has no descriptor: a
        // stale-connection restart loop on the DB is worse than the blindness.
        it('does not enroll the DB in any restart path', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')
            const runArgs = findDockerRunArgs(stubs.execFileAsync)
            expect(runArgs.some(a => /autoheal/i.test(String(a))), 'autoheal flag on the DB container').to.be.false
        })
        })
})

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {

        it('appends MariaDB tuning args to docker run when env vars are set', async function () {
            const saved = {
                XCHAIN_NODE_DB_BUFFER_POOL_SIZE:        process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE,
                XCHAIN_NODE_DB_MAX_CONNECTIONS:         process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS,
                XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT: process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT
            }
            process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE        = '16G'
            process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS         = '300'
            process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT = '2'
            try {
                const stubs = makeStubs()
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runArgs = findDockerRunArgs(stubs.execFileAsync)
                expect(runArgs, 'docker run call not found').to.not.be.null
                // mysqld args must come AFTER the image name, else Docker reads
                // them as `docker run` options instead of the container command.
                const imageIdx = runArgs.indexOf('xchain-node-database')
                const poolIdx  = runArgs.indexOf('--innodb-buffer-pool-size=16G')
                expect(imageIdx).to.be.greaterThan(-1)
                expect(poolIdx).to.be.greaterThan(imageIdx)
                expect(runArgs).to.include('--max-connections=300')
                expect(runArgs).to.include('--innodb-flush-log-at-trx-commit=2')
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('defaults max-connections to 1000 when the env var is unset (multi-chain saturation guard)', async function () {
            const saved = process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
            delete process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
            try {
                const stubs = makeStubs()
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runArgs = findDockerRunArgs(stubs.execFileAsync)
                expect(runArgs, 'docker run call not found').to.not.be.null
                expect(runArgs).to.include('--max-connections=1000')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
                else process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS = saved
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('buildDatabaseModule()', function () {

        it('omits MariaDB tuning args when env vars are unset', async function () {
            const saved = {
                XCHAIN_NODE_DB_BUFFER_POOL_SIZE:        process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE,
                XCHAIN_NODE_DB_MAX_CONNECTIONS:         process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS,
                XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT: process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT
            }
            delete process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE
            delete process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
            delete process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT
            try {
                const stubs = makeStubs()
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runArgs = findDockerRunArgs(stubs.execFileAsync)
                expect(runArgs, 'docker run call not found').to.not.be.null
                expect(runArgs.some(a => a.startsWith('--innodb-buffer-pool-size'))).to.be.false
                // max-connections is deliberately NOT omitted when unset: it falls back to
                // the 1000 default (see the saturation-guard test above).
                expect(runArgs).to.include('--max-connections=1000')
                expect(runArgs.some(a => a.startsWith('--innodb-flush-log-at-trx-commit'))).to.be.false
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })
        })
})
