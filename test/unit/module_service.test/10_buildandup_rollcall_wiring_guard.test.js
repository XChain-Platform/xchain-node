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

// The ROLLCALL wiring guard runs from buildAndUp, the one chokepoint every
// install, update and recreate passes through, before anything is torn down.
// The guard's own verdicts are pinned in rollcall_wiring.test; this pins the
// wiring: a refusal reaches the caller with no docker call made, and a one-shot
// execution container is exempt.

const { sinon, expect, makeStubs, makeConfigServiceStub, loadModuleService, moduleSuite } = require('./support/helpers')

// A docker fake that records every call and answers the create path. The
// indexer stages its bundled xchain-vm with cpSync, so the fixture fs gets one.
function recordDocker(stubs) {
    const seen = []
    stubs.fs.cpSync = sinon.stub()
    stubs.execFile.callsFake((cmd, args, ...rest) => {
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        seen.push({ cmd, args })
        if (args[0] === 'build') cb(null)
        else if (args[0] === 'run') cb(null, 'f'.repeat(64) + '\n')
        else cb(null, '')
    })
    return seen
}

// The deploy env with no DOGE read: what a host .env hands a BTC indexer when
// nothing ever told the operator the variable existed.
function loadWithoutDogeRead(stubs) {
    return loadModuleService(stubs, undefined, {
        './config_service': {
            ...makeConfigServiceStub(),
            getDefaultConfig: sinon.stub().resolves({ INDEXER_PORT: 3004, INDEXER_API_PORT: 3004 })
        }
    })
}

moduleSuite('buildAndUp() ROLLCALL wiring guard', function () {

    it('REFUSES a BTC mainnet indexer whose env carries no DOGE read, before any docker call', async function () {
        const stubs = makeStubs()
        const seen = recordDocker(stubs)
        const ms = loadWithoutDogeRead(stubs)
        let err = null
        try { await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet') } catch (e) { err = e }
        expect(err).to.be.an('error')
        expect(err.code).to.equal('ROLLCALL_DOGE_READ_UNWIRED')
        expect(err.message).to.match(/DOGE_INDEXER_API_URL/)
        expect(seen.some(c => c.cmd === 'docker')).to.equal(false)
    })

    it('lets a one-shot execution container through: it never closes an epoch', async function () {
        const stubs = makeStubs()
        const seen = recordDocker(stubs)
        const ms = loadWithoutDogeRead(stubs)
        await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet', null, true)
        expect(seen.some(c => c.args[0] === 'run')).to.equal(true)
    })

    it('deploys the wired default fixture, whose env carries the DOGE read', async function () {
        const stubs = makeStubs()
        const seen = recordDocker(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet')
        expect(seen.some(c => c.args[0] === 'run')).to.equal(true)
    })
})
