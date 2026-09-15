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
function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquire('../../../src/services/docker_service', {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn,
            spawnSync: stubs.spawnSync
        },
        'fs': fsStub || {
            readFileSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub()
        },
        'blessed': {
            screen: sinon.stub().returns({
                key: sinon.stub(), on: sinon.stub(),
                render: sinon.stub(), destroy: sinon.stub()
            }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment: Docker exec failure (CMD-05)
    describe('Experiment: Docker exec failure', function () {

        it('rejects when exec fails on frozen container', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('OCI runtime exec failed: exec failed: unable to start container process'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.execContainer('frozen-container', ['ls'])
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
                expect(err.message).to.include('exec failed')
            }
        })
    })
})
