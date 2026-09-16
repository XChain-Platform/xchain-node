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

const proxyquire = require('proxyquire').noCallThru()

const TestEnv        = require('../../helpers/test-env')
const CommandCapture = require('../../helpers/command-capture')

// executeDockerMariaDbCommand (98e37a9, predates the argv/env fix under
// test) feeds provisioning SQL to `docker exec -i ... mariadb -u root`
// over the child's STDIN, never as an argv `-e <sql>` token, precisely so
// secret-bearing statements (CREATE USER ... IDENTIFIED BY) never land in
// argv or a docker error message. It reaches the container through raw
// `spawn(...)`, not `execFile`/`execFileAsync`, so CommandCapture's
// shared execFile-based stub never sees the SQL at all, and its generic
// spawn stub records argv but never delivers a response or fires 'close'.
// This local stub replicates spawn's real event contract (stdout/stderr/
// stdin, 'close') for that one call shape, folds the piped SQL into the
// recorded command string, and routes it through the SAME
// `capture.when()` patterns/history the execFile stub already uses, so
// the regex-based assertions below (targeting the actual SQL text, e.g.
// /CREATE USER/) keep working against the real post-fix argv+stdin split.
function makeMariadbSpawnStub(cmdCapture) {
    const EventEmitter = require('events')
    return function spawnStub(command, args) {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin  = new EventEmitter()
        const argvCommand = command + ' ' + (args || []).join(' ')

        child.stdin.end = (data) => {
            const sql = String(data || '').replace(/;\n$/, '')
            const fullCommand = (argvCommand + ' ' + sql).trim()
            cmdCapture.history().push({
                command: fullCommand, args, options: {}, type: 'spawn', timestamp: Date.now()
            })
            const response = cmdCapture._matchRoute(fullCommand)
            process.nextTick(() => {
                if (response.error) {
                    child.stderr.emit('data', String(response.error.message || response.error))
                    child.emit('close', 1)
                } else {
                    if (response.stdout) child.stdout.emit('data', response.stdout)
                    child.emit('close', 0)
                }
            })
        }

        return child
    }
}

function configureCapture(capture, options, dbContainerId) {
    capture.when(/docker pull/).returns({ stdout: '' })
    capture.when(/docker tag/).returns({ stdout: '' })
    capture.when(/docker run/).returns({ stdout: dbContainerId + '\n' })
    capture.when(/docker exec.*SELECT 1/).returns({ stdout: '1' })
    capture.when(/docker exec.*SELECT COUNT\(SCHEMA/).returns({ stdout: '0' })
    capture.when(/docker exec.*SELECT COUNT\(\*\).*mysql.user/).returns({ stdout: '0' })
    capture.when(/docker exec.*CREATE DATABASE/).returns({ stdout: '' })
    capture.when(/docker exec.*CREATE USER/).returns({ stdout: '' })
    capture.when(/docker exec.*SHOW GRANTS/).returns({ stdout: '' })
    capture.when(/docker exec.*GRANT ALL/).returns({ stdout: '' })
    capture.when(/docker exec.*FLUSH/).returns({ stdout: '' })
    capture.when(/docker network inspect/).returns({
        stdout: JSON.stringify([{ IPAM: { Config: [{ Gateway: options.gateway || '172.18.0.1' }] } }])
    })
    // getDatabaseContainerId() runs `docker inspect --type container
    // --format {{.Id}}`, which prints the bare 64-hex container id (not
    // JSON) on success. This route has to be registered ahead of the
    // generic `docker inspect` one below and match its exact shape, or
    // checkIfDatabaseModuleExists()/getDatabaseContainerId() always read
    // back a non-hex string and treat the database as never installed
    // regardless of options.dbContainerId. options.containerExists
    // toggles "database already installed" (used by the reuse/grant
    // tests) vs "fresh install" (the default, used by the first-install
    // test) semantics.
    capture.when(/docker inspect --type container --format/).returns(
        options.containerExists ? { stdout: dbContainerId + '\n' } : { stdout: '' }
    )
    capture.when(/docker inspect/).returns({
        stdout: JSON.stringify([{
            State: { Status: 'running' },
            NetworkSettings: { Ports: {}, Networks: {} }
        }])
    })
}

function proxyDatabaseService(capture, options) {
    const execFileAsyncStub = options.execFileAsyncStub || capture.createExecFileAsyncStub()
    return proxyquire('../../../../src/services/database_service', {
        'child_process': {
            execFile: capture.createExecFileStub(),
            spawn: makeMariadbSpawnStub(capture)
        },
        'util': { promisify: () => execFileAsyncStub },
        'enquirer': { Password: class { async run() { return 'testrootpw' } } },
        './status_service': {
            statusChanged: async () => true,
            getStatus: async () => ({}),
            getInstalledCoinsAndNetworks: async () => options.installedCoins || {}
        },
        './docker_service': {
            getStatusFromContainer: async () => ({
                State: { Status: 'running' },
                NetworkSettings: { Ports: {}, Networks: {} }
            }),
            getDockerNetworkInspect: async () => ({
                IPAM: { Config: [{ Gateway: options.gateway || '172.18.0.1' }] }
            }),
            addContainerToNetwork: async (id, network) => {
                if (options.networkConnections) options.networkConnections.push({ id, network })
                return true
            },
            // Fresh install: docker positively reports the DB container gone,
            // which is what the install branch now requires before it may
            // force-remove anything (uuid:8a3e5182).
            probeContainerPresenceByName: async () => 'gone',
            forceRemoveContainerByName: async () => false
        },
        '../utils/helpers': {
            sleep: async () => {},
            // DatabaseService logs several provisioning steps through
            // redactSecrets(); replacing the whole module without it
            // throws "redactSecrets is not a function" the first time a
            // test actually exercises those log lines (e.g. a successful
            // CREATE DATABASE/CREATE USER). An identity passthrough is
            // fine here: these tests assert on captured commands, not on
            // console output.
            redactSecrets: (s) => s
        }
    })
}

function makeDatabaseService(capture, options = {}) {
    const state = require('../../../../src/state')
    state.setDbRootPassword('testrootpw')

    const dbContainerId = options.dbContainerId || TestEnv.fakeContainerId('d')
    configureCapture(capture, options, dbContainerId)
    const DatabaseService = proxyDatabaseService(capture, options)

    return { DatabaseService, dbContainerId }
}

function databaseSuite(title, registerTests) {
    let env, capture

    describe('Integration: Database Service Chain', function () {
        this.timeout(15000)

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
            env.patchConstants()
            capture = new CommandCapture()
        })

        afterEach(async function () {
            await env.teardown()
        })

        describe(title, function () {
            registerTests(() => ({
                env,
                capture,
                fakeContainerId: TestEnv.fakeContainerId,
                makeDatabaseService: (options) => makeDatabaseService(capture, options)
            }))
        })
    })
}

module.exports = { databaseSuite }
