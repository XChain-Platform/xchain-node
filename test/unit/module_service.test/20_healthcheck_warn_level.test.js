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

const { sinon, expect, makeStubs, loadModuleService, moduleSuite } = require('./support/helpers')

const OVERRIDE_KEY = 'XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER'

// A healthcheck drift notice carries its severity in the level, so a stream or
// level filter that keeps warnings keeps these two.
moduleSuite('buildHealthcheckArgs warning severity', function () {

    let warnSpy, logSpy, saved

    beforeEach(function () {
        warnSpy = sinon.spy(console, 'warn')
        logSpy = sinon.spy(console, 'log')
        saved = process.env[OVERRIDE_KEY]
    })

    afterEach(function () {
        warnSpy.restore()
        logSpy.restore()
        if (saved === undefined) delete process.env[OVERRIDE_KEY]
        else process.env[OVERRIDE_KEY] = saved
    })

    const textOf = (spy) => spy.getCalls().map(c => c.args.join(' ')).join('\n')

    it('reports a malformed start-period override at warn level, not info', function () {
        const ms = loadModuleService(makeStubs())
        process.env[OVERRIDE_KEY] = 'not-a-duration'

        ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })

        expect(textOf(warnSpy)).to.match(new RegExp('WARNING: ignoring ' + OVERRIDE_KEY + '=not-a-duration'))
        expect(textOf(logSpy)).to.not.match(/WARNING: ignoring/)
    })

    it('reports a descriptor with no port env at warn level, not info', function () {
        const ms = loadModuleService(makeStubs())

        expect(ms.buildHealthcheckArgs('xchain-decoder', {})).to.deep.equal([])

        expect(textOf(warnSpy)).to.match(/WARNING: no healthcheck for xchain-decoder: env DECODER_API_PORT is unset/)
        expect(textOf(logSpy)).to.not.match(/WARNING: no healthcheck/)
    })

    it('stays silent at both levels for a well-formed override', function () {
        const ms = loadModuleService(makeStubs())
        process.env[OVERRIDE_KEY] = '900'

        ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })

        expect(textOf(warnSpy)).to.not.match(/WARNING/)
        expect(textOf(logSpy)).to.not.match(/WARNING/)
    })
})
