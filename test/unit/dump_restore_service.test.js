/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const config = require('../../src/config')
const { createDumpRestore } = require('../../src/services/dump_restore_service')
const { dispatchSettings } = require('../../src/cli/dispatch')

const SERVICE = config.XChainService.XCHAIN_INDEXER
const DATABASE = 'XChain_BTC_Testnet_Indexer'
const USER = 'xchain_indexer_bitcoin_testnet'
const COMPLETE_DUMP = 'CREATE TABLE blocks (block_index BIGINT);\n-- Dump completed on 2026-11-22 12:00:00\n'

function makeFile(directory, name, contents = COMPLETE_DUMP, gzip = true) {
    const file = path.join(directory, name)
    fs.writeFileSync(file, gzip ? zlib.gzipSync(contents) : contents)
    return file
}

async function expectRefusal(promise, pattern) {
    let failure = null
    try { await promise } catch (err) { failure = err }
    expect(failure).to.be.instanceOf(Error)
    expect(failure.message).to.match(pattern)
}

function fakeChild(onInput) {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const chunks = []
    child.stdin.on('data', chunk => chunks.push(chunk))
    child.stdin.on('finish', () => {
        onInput(Buffer.concat(chunks).toString(), child)
        child.stdout.end()
        child.stderr.end()
        setImmediate(() => child.emit('close', 0))
    })
    return child
}

function harness(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-dump-restore-'))
    const events = []
    const spawns = []
    const logs = []
    const clearHubPriceIngestWatermark = sinon.stub()
    const recordReindex = sinon.stub()
    const spawn = sinon.stub().callsFake((file, args, options) => {
        spawns.push({ file, args, options })
        return fakeChild((input, child) => {
            if (args.includes(DATABASE)) {
                events.push('stream')
                return
            }
            if (/DROP DATABASE/.test(input)) events.push('drop-create')
            if (/GRANT ALL PRIVILEGES/.test(input)) events.push('grant')
            if (/information_schema\.tables/.test(input)) child.stdout.write('17\n')
            if (/MAX\(block_index\)/.test(input)) child.stdout.write('325\t882001\n')
        })
    })
    const deps = {
        config,
        spawn,
        db: { getModuleContainerStrict: sinon.stub().resolves('service-container') },
        getDefaultConfig: sinon.stub().resolves({
            INDEXER_DB_NAME: DATABASE,
            INDEXER_DB_USER: USER
        }),
        getModuleDatabaseName: sinon.stub().returns(DATABASE),
        getDatabaseContainerId: sinon.stub().resolves('database-container'),
        stopModuleContainer: sinon.stub().callsFake(async () => { events.push('stop') }),
        stopContainer: sinon.stub(),
        startContainer: sinon.stub().callsFake(async () => { events.push('restart') }),
        getContainerStopSettings: sinon.stub(),
        confirmDestructiveReset: sinon.stub().resolves(true),
        logger: { info: message => {
            logs.push(message)
            if (message.startsWith('Verified ')) events.push('verify')
        } },
        clearHubPriceIngestWatermark,
        recordReindex
    }
    Object.assign(deps, overrides)
    return {
        directory, deps, events, spawns, logs,
        restoreDump: createDumpRestore(deps),
        clearHubPriceIngestWatermark, recordReindex
    }
}

describe('DumpRestoreService', function validationTests() {
    it('classifies restore-dump as a lock-holding mutating command', function () {
        expect(dispatchSettings(config).mutatingCommands).to.include('restore-dump')
    })

    it('refuses a missing file', async function () {
        const h = harness()
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', {
            file: path.join(h.directory, `${DATABASE}.missing.sql.gz`), yes: true
        }), /file not found/)
    })

    it('refuses a file without the .sql.gz suffix', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql`, COMPLETE_DUMP, false)
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /must end in \.sql\.gz/)
    })

    it('refuses a corrupt gzip stream', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`, 'not gzip', false)
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /gzip integrity check failed/)
    })

    it('refuses a gzip whose decompressed tail has no completion marker', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`, 'CREATE TABLE blocks (id INT);\n')
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /no final '-- Dump completed' line/)
    })

    it('refuses a dump named for another database', async function () {
        const h = harness()
        const file = makeFile(h.directory, 'XChain_DOGE_Testnet_Indexer.stamp.sql.gz')
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /expected XChain_BTC_Testnet_Indexer/)
    })

    it('refuses mainnet unless --allow-mainnet is separately present', async function () {
        const h = harness()
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'mainnet', {
            file: path.join(h.directory, 'unused.sql.gz'), yes: true
        }), /without --allow-mainnet/)
    })
})

describe('DumpRestoreService', function executionTests() {
    it('uses reset confirmation and refuses a headless run without --yes', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
        h.deps.confirmDestructiveReset.rejects(new Error(
            'reset: refusing to run a destructive reset on a non-interactive terminal without --yes'
        ))
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file }),
            /non-interactive terminal without --yes/)
        expect(h.events).to.deep.equal([])
    })

    it('stops, replaces, imports, grants, verifies, and restarts without leaking a secret', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.20261122T120000Z.sql.gz`)
        const verification = await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })

        expect(verification).to.deep.equal({ tableCount: 17, blockRows: 325, maxBlockIndex: 882001 })
        expect(h.events).to.deep.equal(['stop', 'drop-create', 'stream', 'grant', 'restart', 'verify'])
        expect(h.logs).to.include(`Verified ${DATABASE}: tables=17, blocks=325, max_block_index=882001`)
        const exposed = JSON.stringify(h.spawns) + h.logs.join('\n')
        expect(exposed).not.to.include('root-secret')
        expect(h.spawns.every(call => !call.args.includes('-p'))).to.equal(true)
        expect(h.spawns.every(call => call.args.join(' ').includes('$MYSQL_ROOT_PASSWORD'))).to.equal(true)
        expect(h.clearHubPriceIngestWatermark.called).to.equal(false)
        expect(h.recordReindex.called).to.equal(false)
    })

    it('restores through the external MariaDB client without using a stale container', async function () {
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
    })

    it('touches nothing when external database configuration cannot be read', async function () {
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
    })
})
