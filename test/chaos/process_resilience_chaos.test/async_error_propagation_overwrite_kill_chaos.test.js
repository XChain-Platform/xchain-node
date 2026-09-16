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
const { makeStubs, loadModuleService } = require('./helpers')

describe('Chaos: Process Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

describe('Experiment 11: Async error propagation', function () {

        it('handles rejection from killContainer during overwrite gracefully', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const containerId = 'b'.repeat(64)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, containerId + '\n')
                }
            })

            const ms = loadModuleService(stubs, {
                killContainer: sinon.stub().rejects(new Error('container not running')),
                removeContainer: sinon.stub().resolves(true)
            })

            // killContainer failure should be caught (container may not be running)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest', 'old-container-id')
            expect(result).to.equal(containerId)
        })
    })
})
