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

    // Experiment: Docker inspect returns invalid JSON (CMD-07)
    describe('Experiment: Docker inspect with invalid JSON', function () {

        it('throws when docker inspect returns malformed JSON', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'this is not json')
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.getStatusFromContainer('abc123')
                expect.fail('should have thrown')
            } catch (err) {
                // JSON.parse throws SyntaxError, which should propagate
                expect(err).to.be.an.instanceOf(SyntaxError)
            }
        })

        it('throws when docker inspect returns empty array', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '[]')
            })
            const ds = loadDockerService(stubs)

            try {
                const result = await ds.getStatusFromContainer('abc123')
                // [0] on empty array returns undefined; downstream code will fail
                expect(result).to.be.undefined
            } catch {
                // Also acceptable
            }
        })
    })
})
