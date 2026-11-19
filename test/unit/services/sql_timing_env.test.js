'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const {
    makeStubs,
    loadModuleService
} = require('../module_service.test/support/helpers')

const SQL_TIMING_ENV = {
    SQL_TIMING_ENABLED: 'timing-enabled-value',
    SQL_TIMING_URL: 'https://timing.invalid/intake',
    SQL_TIMING_KEY: 'timing-key-value',
    SQL_TIMING_PROJECT: 'timing-project-value',
    SQL_TIMING_REQUEST_RATE: 'timing-request-rate-value',
    SQL_TIMING_STATEMENT_RATE: 'timing-statement-rate-value',
    SQL_TIMING_INTERVAL_MS: 'timing-interval-value',
    SQL_TIMING_MAX_BUFFER: 'timing-buffer-value'
}

describe('SQL timing container environment', function () {
    let savedEnv

    beforeEach(function () {
        savedEnv = Object.fromEntries(
            Object.keys(SQL_TIMING_ENV).map(name => [name, process.env[name]])
        )
        Object.assign(process.env, SQL_TIMING_ENV)
    })

    afterEach(function () {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('passes every host value as a bare Docker environment name', async function () {
        const stubs = makeStubs()
        let runArgs
        let runOptions
        stubs.execFile.callsFake((command, args, ...rest) => {
            const options = typeof rest[0] === 'function' ? {} : rest[0]
            const callback = typeof rest[0] === 'function' ? rest[0] : rest[1]
            if (args[0] === 'build') callback(null)
            else if (args[0] === 'run') {
                runArgs = args
                runOptions = options
                callback(null, 'a'.repeat(64) + '\n')
            } else callback(null)
        })

        const moduleService = loadModuleService(stubs)
        await moduleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

        for (const [name, value] of Object.entries(SQL_TIMING_ENV)) {
            const nameIndex = runArgs.indexOf(name)
            expect(nameIndex, name).to.be.greaterThan(0)
            expect(runArgs[nameIndex - 1], name).to.equal('--env')
            expect(runOptions.env[name], name).to.equal(value)
            expect(runArgs, name).to.not.include(value)
            expect(runArgs, name).to.not.include(`${name}=${value}`)
        }
    })
})
