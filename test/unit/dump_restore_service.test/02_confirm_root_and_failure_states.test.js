/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'
// Confirmation, the root probe, and what each failed step reports.

const { expect, sinon, EventEmitter, PassThrough, config, SERVICE, DATABASE, makeFile, expectRefusal, fakeChild, harness } = require('./helpers')

async function refusesHeadlessRunWithoutYes() {
    const h = harness()
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    h.deps.confirmDestructiveReset.rejects(new Error(
        'reset: refusing to run a destructive reset on a non-interactive terminal without --yes'
    ))
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file }),
        /non-interactive terminal without --yes/)
    expect(h.events).to.deep.equal([])
}

async function namesTheRestoreWhenHeadlessWithoutYes() {
    const { confirmDestructiveReset } = require('../../../src/operations/module_operations/repo_refs')
    const h = harness({ confirmDestructiveReset })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
        let thrown = null
        try {
            await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file })
        } catch (err) { thrown = err }
        expect(thrown).to.not.equal(null)
        expect(thrown.message).to.match(/restore-dump/)
        expect(thrown.message).to.match(/without --yes/)
        expect(thrown.message).to.not.match(/reset/)
        expect(h.events).to.deep.equal([])
    } finally {
        if (saved) Object.defineProperty(process.stdin, 'isTTY', saved)
        else delete process.stdin.isTTY
    }
}

async function restoresWithoutLeakingSecret() {
    const h = harness()
    const file = makeFile(h.directory, `${DATABASE}.20261122T120000Z.sql.gz`)
    const verification = await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })

    expect(verification).to.deep.equal({ tableCount: 17, blockRows: 325, maxBlockIndex: 882001 })
    expect(h.events).to.deep.equal(['stop', 'drop-create', 'stream', 'grant', 'restart', 'verify'])
    expect(h.logs).to.include(`Verified ${DATABASE}: tables=17, blocks=325, max_block_index=882001`)
    // The root password travels only in the child's MYSQL_PWD env, never argv or logs.
    const exposed = JSON.stringify(h.spawns.map(call => call.args)) + h.logs.join('\n')
    expect(exposed).not.to.include('root-secret')
    expect(h.spawns.every(call => !call.args.includes('-p'))).to.equal(true)
    expect(h.spawns.every(call => call.file === 'docker' && call.args.includes('MYSQL_PWD'))).to.equal(true)
    expect(h.spawns.every(call => call.options.env.MYSQL_PWD === 'root-secret')).to.equal(true)
    expect(h.deps.askMariadbRootPassword.calledWith('bitcoin', 'testnet')).to.equal(true)
    expect(h.clearHubPriceIngestWatermark.called).to.equal(false)
    expect(h.recordReindex.called).to.equal(false)
}

async function restoresThroughExternalClient() {
    const externalConfig = Object.create(config, { EXTERNAL_DB: { value: true } })
    const getExternalDbConfig = sinon.stub().resolves({
        host: '10.0.0.5', port: 3307, root_user: 'root', root_password: 'ext-secret'
    })
    const h = harness({
        config: externalConfig,
        getExternalDbConfig,
        mariadbEnv: password => ({ MYSQL_PWD: password })
    })
    const file = makeFile(h.directory, `${DATABASE}.external.sql.gz`)
    const verification = await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })

    expect(verification).to.deep.equal({ tableCount: 17, blockRows: 325, maxBlockIndex: 882001 })
    expect(h.deps.getDatabaseContainerId.called).to.equal(false)
    expect(h.spawns.every(call => call.file === 'mariadb')).to.equal(true)
    expect(h.spawns.every(call => call.args.includes('-h') && call.args.includes('10.0.0.5'))).to.equal(true)
    expect(h.spawns.every(call => call.args.includes('-P') && call.args.includes('3307'))).to.equal(true)
    expect(h.spawns.every(call => call.options.env.MYSQL_PWD === 'ext-secret')).to.equal(true)
    expect(JSON.stringify(h.spawns.map(call => call.args))).to.not.include('ext-secret')
    expect(h.events).to.deep.equal(['stop', 'drop-create', 'stream', 'grant', 'restart', 'verify'])
}

async function refusesUnreadableExternalConfiguration() {
    const externalConfig = Object.create(config, { EXTERNAL_DB: { value: true } })
    const h = harness({
        config: externalConfig,
        getExternalDbConfig: sinon.stub().rejects(new Error('external configuration unavailable'))
    })
    const file = makeFile(h.directory, `${DATABASE}.external.sql.gz`)
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
        /external configuration unavailable/)
    expect(h.deps.getDatabaseContainerId.called).to.equal(false)
    expect(h.deps.stopModuleContainer.called).to.equal(false)
    expect(h.deps.spawn.called).to.equal(false)
}

const ROOT_DENIED = "ERROR 1045 (28000) Access denied for user 'root'@'localhost' (using password: NO)"

// A database whose root login fails: every client spawn exits 1 with the
// server's access-denied text, and every SQL text it was fed is recorded.
function deniedRootHarness() {
    const sql = []
    const spawn = sinon.stub().callsFake(() => fakeChild((input, child) => {
        sql.push(input)
        child.stderr.write(`${ROOT_DENIED}\n`)
        child.exitCode = 1
    }))
    const h = harness({ spawn })
    return { ...h, sql }
}

async function refusesBeforeStoppingWhenRootIsDenied() {
    const h = deniedRootHarness()
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
        /root access check failed; nothing was stopped or changed.*Access denied/)
    expect(h.deps.stopModuleContainer.called).to.equal(false)
    expect(h.deps.startContainer.called).to.equal(false)
    expect(h.deps.confirmDestructiveReset.called).to.equal(false)
    expect(h.sql.some(text => /DROP|CREATE|GRANT/i.test(text))).to.equal(false)
    expect(h.events).to.deep.equal([])
}

async function refusesBeforeStoppingWhenNoRootPassword() {
    const h = harness({ askMariadbRootPassword: sinon.stub().resolves(null) })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
        /no MariaDB root password is available/)
    expect(h.deps.stopModuleContainer.called).to.equal(false)
    expect(h.deps.spawn.called).to.equal(false)
}

async function probesRootBeforeTheUnchangedRestoreOrder() {
    const h = harness()
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })
    expect(h.spawns.length).to.be.greaterThan(1)
    expect(h.deps.spawn.firstCall.calledBefore(h.deps.stopModuleContainer.firstCall)).to.equal(true)
    expect(h.events).to.deep.equal(['stop', 'drop-create', 'stream', 'grant', 'restart', 'verify'])
}

// A root login that passes the probe but fails at DROP: the service is
// already stopped, so the error must say so instead of only quoting SQL.
async function namesTheStoppedServiceWhenDropFails() {
    const spawn = sinon.stub().callsFake(() => fakeChild((input, child) => {
        if (/DROP DATABASE/.test(input)) {
            child.stderr.write(`${ROOT_DENIED}\n`)
            child.exitCode = 1
        }
    }))
    const h = harness({ spawn })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
        new RegExp(`Access denied.*${SERVICE} \\(bitcoin testnet\\) was left stopped because ${DATABASE} may be missing`))
    expect(h.deps.stopModuleContainer.calledOnce).to.equal(true)
    expect(h.deps.startContainer.called).to.equal(false)
}

async function namesTheImportErrorAndTheStoppedState() {
    const spawn = sinon.stub().callsFake((file, args) => fakeChild((input, child) => {
        if (args.includes(DATABASE)) {
            child.stderr.write("ERROR 1146 (42S02) at line 61: Table 'x' doesn't exist\n")
            child.exitCode = 1
        }
    }))
    const h = harness({ spawn })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
        new RegExp(`exit 1: ERROR 1146 .*doesn't exist; ${SERVICE} \\(bitcoin testnet\\) was left stopped because ${DATABASE} may be missing or partially imported; restore a sound dump before starting it`))
    expect(h.deps.stopModuleContainer.calledOnce).to.equal(true)
    expect(h.deps.startContainer.called).to.equal(false)
}

async function importEpipeDoesNotMaskTheMariadbError() {
    // MariaDB exits on its first bad statement while the dump is still
    // streaming: the stdin write fails with EPIPE before the process closes.
    let importStdin = null
    const spawn = sinon.stub().callsFake((file, args) => {
        if (!args.includes(DATABASE)) return fakeChild(() => {})
        const child = new EventEmitter()
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        importStdin = child.stdin
        setTimeout(() => {
            child.stderr.write("ERROR 1146 (42S02) at line 2: Table 'x' doesn't exist\n")
            setTimeout(() => child.emit('close', 1), 20)
        }, 10)
        return child
    })
    const realPipeline = require('stream/promises').pipeline
    const pipeline = (...streams) => streams[streams.length - 1] === importStdin
        ? new Promise((resolve, reject) => setImmediate(() => reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))))
        : realPipeline(...streams)
    const h = harness({ spawn, pipeline })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    let failure = null
    try { await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }) } catch (err) { failure = err }
    expect(failure).to.be.instanceOf(Error)
    expect(failure.message).to.match(/exit 1: ERROR 1146 /)
    expect(failure.message).to.not.match(/EPIPE/)
    expect(failure.message).to.match(new RegExp(`${SERVICE} \\(bitcoin testnet\\) was left stopped`))
    expect(h.deps.stopModuleContainer.calledOnce).to.equal(true)
    expect(h.deps.startContainer.called).to.equal(false)
}

async function namesTheStateWhenTheRestartFails() {
    const h = harness({ startContainer: sinon.stub().rejects(new Error('docker start failed')) })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
        new RegExp(`docker start failed; ${DATABASE} was restored but ${SERVICE} \\(bitcoin testnet\\) did not start`))
}

async function proceedsOnTheFallbackRootWithoutContainerEnv() {
    // The container carries no MYSQL_ROOT_PASSWORD; the shared resolver
    // returns the stored credential and the probe accepts it.
    const h = harness({ askMariadbRootPassword: sinon.stub().resolves('stored-root') })
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    const verification = await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })
    expect(verification.tableCount).to.equal(17)
    expect(h.spawns.every(call => call.options.env.MYSQL_PWD === 'stored-root')).to.equal(true)
    expect(h.events).to.deep.equal(['stop', 'drop-create', 'stream', 'grant', 'restart', 'verify'])
}

describe('DumpRestoreService', function executionTests() {
    it('names the stopped service and the uncertain database when DROP fails after the stop', namesTheStoppedServiceWhenDropFails)
    it('reports the MariaDB import error and that the service stays stopped', namesTheImportErrorAndTheStoppedState)
    it('keeps the MariaDB error when the stdin pipe fails with EPIPE first', importEpipeDoesNotMaskTheMariadbError)
    it('names the restored database and the down service when the restart fails', namesTheStateWhenTheRestartFails)
    it('proceeds when root resolves from the fallback credential, not the container env', proceedsOnTheFallbackRootWithoutContainerEnv)
    it('refuses before stopping anything when MariaDB denies root', refusesBeforeStoppingWhenRootIsDenied)
    it('refuses before stopping anything when no root password resolves', refusesBeforeStoppingWhenNoRootPassword)
    it('probes root before the unchanged stop, replace, import, restart order', probesRootBeforeTheUnchangedRestoreOrder)
    it('uses reset confirmation and refuses a headless run without --yes', refusesHeadlessRunWithoutYes)
    it('names restore-dump, not a reset, when the real confirmation refuses a headless run', namesTheRestoreWhenHeadlessWithoutYes)
    it('stops, replaces, imports, grants, verifies, and restarts without leaking a secret', restoresWithoutLeakingSecret)
    it('restores through the external MariaDB client without using a stale container', restoresThroughExternalClient)
    it('touches nothing when external database configuration cannot be read', refusesUnreadableExternalConfiguration)
})
