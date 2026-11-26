/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'
// Shared fixtures for the restore-dump service suites in this directory.

const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const config = require('../../../src/config')
const { createDumpRestore } = require('../../../src/services/dump_restore_service')
const { dispatchSettings } = require('../../../src/cli/dispatch')

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
        setImmediate(() => child.emit('close', child.exitCode || 0))
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
        askMariadbRootPassword: sinon.stub().resolves('root-secret'),
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

module.exports = { expect, sinon, fs, os, path, zlib, EventEmitter, PassThrough, config, createDumpRestore, dispatchSettings, SERVICE, DATABASE, USER, COMPLETE_DUMP, makeFile, expectRefusal, fakeChild, harness }
