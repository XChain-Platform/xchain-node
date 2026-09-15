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

function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadModuleService(stubs, opts = {}) {
    return proxyquire('../../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        },
        '../state': {
            db: opts.db || {
                setModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                deleteModuleContainer: sinon.stub().resolves(true)
            },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './config_service': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: (mod, coin, net) => {
                if (['database', 'xchain-hub', 'xchain-explorer', 'xchain-sync'].includes(mod)) {
                    return 'xchain-node-' + mod
                }
                return 'xchain-node-' + coin + '-' + net + '-' + mod
            },
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
            validatePort: (v) => {
                if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535
                if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 }
                return false
            },
            getDefaultConfig: sinon.stub().resolves({
                'NETWORK': 'bitcoin-regtest',
                'NODE_PORT': 18444,
                'ENCODER_PORT': 3003,
                'ENCODER_API_PORT': 3003
            })
        },
        './status_service': {
            statusChanged: sinon.stub().resolves(),
            getStatus: sinon.stub().resolves({})
        },
        './docker_service': {
            killContainer: opts.killContainer || sinon.stub().resolves(true),
            removeContainer: opts.removeContainer || sinon.stub().resolves(true),
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
        },
        './database_service': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 4c: LevelDB insert failure after successful run
    describe('Experiment 4c: State storage failure after successful docker run', function () {

        it('rejects when LevelDB insert returns false', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const dbStub = {
                setModuleContainer: sinon.stub().resolves(false),
                getModuleContainer: sinon.stub().resolves(null),
                deleteModuleContainer: sinon.stub().resolves(true)
            }

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs, { db: dbStub })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("problem trying to store the container's id")
            }
        })
    })
})
