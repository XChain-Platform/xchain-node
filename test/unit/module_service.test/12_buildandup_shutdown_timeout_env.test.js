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

// Pins the drain budget the node hands a service at creation: the decoder and
// tracker get SHUTDOWN_TIMEOUT_MS derived from their stop budget, off argv like
// every other env value, and an explicit module config value is left alone.

const {
    sinon, expect, makeStubs, makeConfigServiceStub, loadModuleService,
    inspectMemoryBytes, moduleSuite
} = require('./support/helpers')

// Records every docker call with its options; the tracker's memory readback
// answers like the shared create fake does.
function captureCreate(stubs) {
    const seen = []
    stubs.execFile.callsFake((cmd, args, ...rest) => {
        const opts = typeof rest[0] === 'function' ? {} : (rest[0] || {})
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        seen.push({ cmd, args, opts })
        if (args[0] === 'run') cb(null, 'd'.repeat(64) + '\n', '')
        else if (args[0] === 'inspect') cb(null, String(inspectMemoryBytes(seen, 'requested')) + '\n')
        else cb(null, '')
    })
    return () => seen.find(c => c.args[0] === 'run')
}

async function createWithConfig(module, extraConfig, onlyExecution = false) {
    const stubs = makeStubs()
    const configService = makeConfigServiceStub()
    if (extraConfig) {
        const base = await configService.getDefaultConfig()
        configService.getDefaultConfig = sinon.stub().resolves({ ...base, ...extraConfig })
    }
    const runOf = captureCreate(stubs)
    const ms = loadModuleService(stubs, null, { './config_service': configService })
    await ms.buildAndUp(module, 'bitcoin', 'mainnet', null, onlyExecution)
    return runOf()
}

moduleSuite('buildAndUp() SHUTDOWN_TIMEOUT_MS', function () {
    it('hands the decoder and tracker the drain derived from their budget, by name only on argv', async function () {
        for (const module of ['xchain-decoder', 'xchain-utxo-tracker']) {
            const run = await createWithConfig(module)
            expect(run.args, module).to.include('SHUTDOWN_TIMEOUT_MS')
            expect(run.args, module).to.not.include('SHUTDOWN_TIMEOUT_MS=100000')
            expect(run.opts.env.SHUTDOWN_TIMEOUT_MS, module).to.equal('100000')
        }
    })

    it('leaves a service on the plain default budget to its own drain default', async function () {
        const run = await createWithConfig('xchain-encoder')
        expect(run.args).to.not.include('SHUTDOWN_TIMEOUT_MS')
        expect(run.opts.env.SHUTDOWN_TIMEOUT_MS).to.equal(undefined)
    })

    it('keeps an explicit SHUTDOWN_TIMEOUT_MS from the module config', async function () {
        const run = await createWithConfig('xchain-decoder', { SHUTDOWN_TIMEOUT_MS: '45000' })
        expect(run.opts.env.SHUTDOWN_TIMEOUT_MS).to.equal('45000')
    })

    it('gives a one-shot execution container no drain, as it gets no stop budget', async function () {
        const run = await createWithConfig('xchain-decoder', null, true)
        expect(run.args).to.not.include('--stop-timeout')
        expect(run.args).to.not.include('SHUTDOWN_TIMEOUT_MS')
    })
})
