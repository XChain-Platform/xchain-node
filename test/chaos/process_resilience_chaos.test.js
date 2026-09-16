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

const { makeStubs, loadModuleService } = require('./process_resilience_chaos.test/helpers')

describe('Chaos: Process Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 11: Async error propagation (SIG-04)
    describe('Experiment 11: Async error propagation', function () {

        it('propagates rejection from docker build failure', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(new Error('Unexpected build error'))
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error creating Docker image')
                expect(err).to.include('Unexpected build error')
            }
        })
    })
})
