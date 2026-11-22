'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { EventEmitter } = require('events')
const { Writable } = require('stream')
const { promisify } = require('util')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

function fakeSpawn() {
    const child = new EventEmitter()
    child.stdin = new Writable({ write(chunk, encoding, done) { done() } })
    child.stdin.once('finish', () => setImmediate(() => child.emit('close', 0)))
    return child
}

function loadHarness() {
    const calls = []
    const execFile = function () {}
    execFile[promisify.custom] = async (file, args) => {
        calls.push({ file, args })
        const stdout = args.includes('mariadb-show') ? '| Rows |\n| 1 |\n' : ''
        return { stdout, stderr: '' }
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-rehearsal-leftover-'))
    const innerArchive = path.join(workDir, 'dump.sql.gz')
    fs.writeFileSync(innerArchive, zlib.gzipSync('SELECT 1;'))
    const commands = proxyquire('../../../src/cli/commands', {
        'child_process': { execFile, spawn: fakeSpawn },
        '../services/bootstrap_service': {
            getBootstrapFilesList: async () => ['archive.tar'], checkBootstrapSignature: async () => {},
            ensureVerifiedInnerArchive: async () => innerArchive
        },
        '../services/bootstrap_service/restore_archive': { assertArchiveIdentity: async () => {} },
        '../services/bootstrap_service/workspace': { getWorkDir: () => workDir },
        '../services/database_service': {
            getDatabaseContainerId: async () => 'db-cid', askMariadbRootPassword: async () => 'test-password'
        },
        '../services/config_service': {
            getDefaultConfig: async () => ({ INDEXER_DB_NAME: 'source_db', INDEXER_BOOTSTRAP_VOLUME: workDir }),
            getModuleDatabaseName: () => 'source_db'
        }
    })
    return { calls, commands }
}

describe('bootstrap restore rehearsal leftover recovery', function () {
    it('drops a leftover database before creating the disposable database', async function () {
        const { calls, commands } = loadHarness()
        expect(await commands.rehearseBootstrapRestore('bitcoin', 'mainnet', {})).to.equal(true)
        const rendered = calls.map(call => call.args.join(' '))
        const preDrop = rendered.findIndex(line => line.includes('DROP DATABASE IF EXISTS'))
        const create = rendered.findIndex(line => line.includes('mariadb-admin') && line.includes(' create '))
        const finalDrop = rendered.findIndex(line => line.includes('mariadb-admin') && line.includes(' drop '))
        expect(preDrop).to.be.at.least(0)
        expect(create).to.be.greaterThan(preDrop)
        expect(finalDrop).to.be.greaterThan(create)
    })
})
