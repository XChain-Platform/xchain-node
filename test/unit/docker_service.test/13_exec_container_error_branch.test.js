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
const { proxyquireDockerService } = require('../../helpers/docker_service_loader')

// Helpers
function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquireDockerService(require.resolve('../../../src/services/docker_service'), {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn,
            spawnSync: stubs.spawnSync
        },
        'util': { promisify: (fn) => fn },
        'fs': fsStub || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({
                key: sinon.stub(),
                on: sinon.stub(),
                render: sinon.stub(),
                destroy: sinon.stub()
            }),
            text: sinon.stub(),
            log: sinon.stub().returns({
                log: sinon.stub()
            })
        }
    })
}

describe('DockerService', function () {


    // execContainer: error branch
    describe('execContainer(): error branch', function () {

        it('rejects when docker exec fails', async function () {
            const stubs = makeStubs()
            // The callback form of execFile hands stdout and stderr to the callback, never to the error.
            const failure = Object.assign(new Error('exec failed'), { code: 4 })
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(failure, 'live marker line\n', 'REFUSED line\n')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.execContainer('abc123', ['ls'])
                expect.fail()
            } catch (err) {
                expect(err).to.equal(failure)
                expect(err.code).to.equal(4)
                expect(err.stdout).to.equal('live marker line\n')
                expect(err.stderr).to.equal('REFUSED line\n')
            }
        })
    })
})


