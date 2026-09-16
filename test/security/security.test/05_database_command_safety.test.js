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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function makeExecFileStub() {
    return sinon.stub()
}

// executeDockerMariaDbCommand pipes SQL to the mariadb client over STDIN (never
// argv). This builds a fake `spawn` child that records argv (`_args`) and the
// piped SQL (`_stdin`) and resolves with empty output. Grab the child via
// `stubs.spawn.firstCall.returnValue`.
function makeDbSpawnStub() {
    const { EventEmitter } = require('events')
    return sinon.stub().callsFake(function (cmd, args, opts) {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child._args = args
        child._env = opts && opts.env
        child._stdin = ''
        child.stdin = {
            write(d) { if (d != null) child._stdin += d },
            end(d) {
                if (d != null) child._stdin += d
                setImmediate(() => child.emit('close', 0))
            },
            on() {}
        }
        return child
    })
}

function loadDatabaseService(stubs) {
    return proxyquire('../../../src/services/database_service', {
        'child_process': { execFile: stubs.execFile, spawn: stubs.spawn || makeDbSpawnStub() },
        'util': { promisify: () => stubs.execFileAsync || sinon.stub().resolves({ stdout: '', stderr: '' }) },
        'mariadb': {},
        'enquirer': { Password: sinon.stub() },
        '../state': {
            db: stubs.db || { getModuleContainer: sinon.stub().resolves('db-container-123') },
            getDbRootPassword: stubs.getDbRootPassword || sinon.stub().returns('rootpass'),
            setDbRootPassword: sinon.stub()
        },
        '../utils/helpers': { sleep: sinon.stub().resolves() },
        './config_service': {
            getDefaultConfig: sinon.stub().resolves({}),
            getDockerContainerImageName: sinon.stub().returns('xchain-node-database'),
            getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
            getModuleDatabaseName: sinon.stub().returns('XChain_BTC_Mainnet_Decoder')
        },
        './docker_service': {
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
            getDockerNetworkInspect: sinon.stub().resolves({ IPAM: { Config: [{ Gateway: '172.18.0.1' }] } }),
            addContainerToNetwork: sinon.stub().resolves()
        },
        './status_service': { statusChanged: sinon.stub().resolves() }
    })
}

describe('Security', function () {
    // SEC-002: Database command safety
    describe('Database command safety', function () {

        it('executeDockerMariaDbCommand pipes SQL via stdin, never argv', async function () {
            const stubs = { execFile: makeExecFileStub(), spawn: makeDbSpawnStub() }
            const ds = loadDatabaseService(stubs)
            const sql = "SELECT COUNT(*) FROM mysql.user WHERE user = 'test'"
            await ds.executeDockerMariaDbCommand('db-container', 'rootpass', sql, '-B -N')

            const child = stubs.spawn.firstCall.returnValue
            expect(stubs.spawn.firstCall.args[0]).to.equal('docker')
            // The SQL must NOT appear anywhere in argv; it is piped via stdin.
            // This keeps a user-creation statement's embedded PASSWORD('...')
            // out of the child's /proc/<pid>/cmdline.
            expect(child._args.some(a => String(a).includes('mysql.user'))).to.be.false
            expect(child._args).to.not.include('-e' + sql)
            expect(child._stdin).to.include(sql)
            // Command options stay as separate argv elements.
            expect(child._args).to.include('-B')
            expect(child._args).to.include('-N')
        })

        it('password travels via MYSQL_PWD env, never a -p argv token', async function () {
            const stubs = { execFile: makeExecFileStub(), spawn: makeDbSpawnStub() }
            const ds = loadDatabaseService(stubs)
            const password = 'pa$$w0rd`whoami`'
            await ds.executeDockerMariaDbCommand('db-container', password, 'SELECT 1')

            const child = stubs.spawn.firstCall.returnValue
            // No -p<password> token anywhere; the secret is only in the env.
            expect(child._args.some(a => String(a).startsWith('-p'))).to.be.false
            expect(child._args.some(a => String(a).includes(password))).to.be.false
            expect(child._env.MYSQL_PWD).to.equal(password)
        })
    })
})
