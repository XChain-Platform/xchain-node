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

// A decoder or indexer buildAndUp under a non-default NODE_PREFIX on an
// external database refuses while the DB name is still the unprefixed default,
// before any docker call is made.

const {
    sinon, expect, makeStubs, makeConfigServiceStub, loadModuleService, moduleSuite, stubDockerCreate
} = require('./support/helpers')

const LEGACY = {
    'xchain-decoder': ['DECODER_DB_NAME', 'XChain_BTC_Mainnet_Decoder'],
    'xchain-indexer': ['INDEXER_DB_NAME', 'XChain_BTC_Mainnet_Indexer']
}
const REFUSAL = 'unprefixed default database name'

function load(stubs, module, dbName, overrides) {
    const base = makeConfigServiceStub().getDefaultConfig
    const constants = { NODE_PREFIX: 'stack2', DEFAULT_NODE_PREFIX: 'xchain-node', EXTERNAL_DB: true, ...overrides }
    return loadModuleService(stubs, constants, {
        './config_service': {
            ...makeConfigServiceStub(constants),
            getDefaultConfig: sinon.stub().callsFake(async (...a) => ({ ...(await base(...a)), [LEGACY[module][0]]: dbName }))
        }
    })
}

// The docker fake answers the whole create path, so a run that clears the
// guard completes instead of hanging on an execFile that never calls back.
function fakeDocker(stubs) {
    stubs.fs.cpSync = sinon.stub()
    return stubDockerCreate(stubs)
}

async function attempt(ms, module) {
    try { await ms.buildAndUp(module, 'bitcoin', 'mainnet') } catch (e) { return e }
    return null
}

function messageOf(err) {
    return String(err && err.message ? err.message : err)
}

moduleSuite('buildAndUp() legacy DB name collision', function () {
    for (const module of Object.keys(LEGACY)) {
        const [key, legacyName] = LEGACY[module]

        it(`REFUSES ${module} under a non-default prefix on an external DB with the unprefixed ${key}`, async function () {
            const stubs = makeStubs()
            const seen = fakeDocker(stubs)
            const err = await attempt(load(stubs, module, legacyName), module)
            expect(err).to.be.an('error')
            expect(err.message).to.include(key)
            expect(err.message).to.include(legacyName)
            expect(seen).to.have.length(0)
        })

        it(`lets ${module} past the guard when ${key} is a stack-unique name`, async function () {
            const stubs = makeStubs()
            const seen = fakeDocker(stubs)
            const err = await attempt(load(stubs, module, 'stack2_' + legacyName), module)
            expect(messageOf(err)).to.not.include(REFUSAL)
        })

        it(`does not refuse ${module} under the default prefix`, async function () {
            const stubs = makeStubs()
            const seen = fakeDocker(stubs)
            const err = await attempt(load(stubs, module, legacyName, { NODE_PREFIX: 'xchain-node' }), module)
            expect(messageOf(err)).to.not.include(REFUSAL)
        })

        it(`does not refuse ${module} when the database is not external`, async function () {
            const stubs = makeStubs()
            const seen = fakeDocker(stubs)
            const err = await attempt(load(stubs, module, legacyName, { EXTERNAL_DB: false }), module)
            expect(messageOf(err)).to.not.include(REFUSAL)
        })
    }
})
