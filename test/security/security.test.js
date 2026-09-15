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

// Helpers
function makeExecFileStub() {
    return sinon.stub()
}

function loadDockerService(stubs) {
    return proxyquire('../../src/services/docker_service', {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn || sinon.stub(),
            spawnSync: stubs.spawnSync || sinon.stub()
        },
        'fs': stubs.fs || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

function loadModuleService(stubs, configOverrides) {
    const configServiceStub = {
        getModuleDir: (mod) => '/modules/' + mod,
        getModuleTmpDir: (mod) => '/tmp/' + mod,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (mod, coin, net) => `xchain-node-${coin}-${net}-${mod}`,
        getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'mainnet',
            'NODE_PORT': 8332,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        }),
        ...(configOverrides || {})
    }

    return proxyquire('../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
        '../state': { db: stubs.db || { setModuleContainer: sinon.stub().resolves(true) }, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
        './config_service': configServiceStub,
        './status_service': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './docker_service': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), getStatusFromContainer: sinon.stub().resolves({}),
            // buildAndUp now runs a host-port-conflict pre-check (assertNoHostPortConflicts ->
            // getPublishedHostPorts), which returns a Map<hostPort, Set<name>>. Empty Map = no
            // conflict, so the container-ID validation path under test is reached.
            getPublishedHostPorts: sinon.stub().resolves(new Map()) },
        './database_service': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

// Security Tests
describe('Security', function () {

    // SEC-001: execFile prevents shell injection
    describe('Shell injection prevention via execFile', function () {

        it('DockerService uses execFile (no shell) for all Docker commands', async function () {
            const stubs = { execFile: makeExecFileStub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            await ds.startContainer('abc123')
            expect(stubs.execFile.calledOnce).to.be.true
            const [cmd, args] = stubs.execFile.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.be.an('array')
            expect(args).to.deep.equal(['start', 'abc123'])
        })

        it('execContainer passes command as array elements, not a shell string', async function () {
            const stubs = { execFile: makeExecFileStub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'output\n')
            })
            const ds = loadDockerService(stubs)
            // Pass as array; shell metacharacters are treated as literals
            await ds.execContainer('abc123', ['echo', '$(whoami)'])
            const [cmd, args] = stubs.execFile.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.deep.equal(['exec', '-i', 'abc123', 'echo', '$(whoami)'])
        })

        it('shell metacharacters in container IDs are passed literally to execFile', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const maliciousId = 'abc; rm -rf /'
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, maliciousId + '\n')
            })
            const ds = loadDockerService(stubs)
            // The malicious string is passed as a single array element
            try {
                await ds.stopContainer(maliciousId)
            } catch { /* may reject due to ID mismatch; that's fine */ }
            const [, args] = stubs.execFile.firstCall.args
            expect(args[0]).to.equal('stop')
            expect(args[1]).to.equal(maliciousId)
            // With execFile, this is safe; no shell interprets the semicolon
            // The $(whoami) is a literal string, not interpreted by shell
        })
    })
})

describe('Security', function () {
    describe('Shell injection prevention via execFile', function () {
        it('buildAndUp passes env vars via the child env (bare --env NAME), never as values in argv', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { setModuleContainer: sinon.stub().resolves(true) } }
            let runArgs = null
            let runOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const opts = typeof rest[0] === 'object' && rest[0] !== null ? rest[0] : null
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'run') {
                    runArgs = args
                    runOpts = opts
                    cb(null, 'a'.repeat(64) + '\n')
                } else {
                    cb(null, '')
                }
            })

            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'HUB_DB_PASS': 's3cr3t-pw',
                    'HUB_API_KEY': 'api-key-xyz',
                    'DANGEROUS_VAR': 'value$(whoami)'
                })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

            // Secrets (and every env value) reach the container through the child
            // process env, keeping them out of argv / /proc/<pid>/cmdline and out
            // of a failed-run error.message.
            expect(runOpts).to.be.an('object')
            expect(runOpts.env).to.include({ HUB_DB_PASS: 's3cr3t-pw', HUB_API_KEY: 'api-key-xyz' })
            // argv carries only the NAME (bare --env), never the value.
            expect(runArgs).to.include('--env')
            expect(runArgs).to.include('HUB_DB_PASS')
            const argvStr = runArgs.join(' ')
            expect(argvStr).to.not.include('s3cr3t-pw')
            expect(argvStr).to.not.include('api-key-xyz')
            expect(argvStr).to.not.include('HUB_DB_PASS=')
            // A hostile value in the env still can't reach a shell (execFile, no shell).
            expect(runArgs).to.not.include('DANGEROUS_VAR=value$(whoami)')
            expect(runOpts.env.DANGEROUS_VAR).to.equal('value$(whoami)')
        })
    })
})
