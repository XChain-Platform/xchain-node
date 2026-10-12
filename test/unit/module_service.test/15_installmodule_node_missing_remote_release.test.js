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

// Loads ModuleService with the given remote node entry and a spy download.
function loadWithRemoteEntry(entry, getCryptoNode) {
    const stubs = makeStubs()
    return loadModuleService(stubs, undefined, {
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({ 'node-bitcoin': entry }),
            getLastStatus: () => null
        },
        './node_service': {
            buildCryptoNode: sinon.stub().resolves(true),
            getCryptoNode
        }
    })
}

moduleSuite('installModule(): node: no remote release to download', function () {
    // A null entry is what checkRemoteNodeVersion stores for a coin it has no
    // release source for; an entry without a tag is the same missing answer.
    for (const [label, entry] of [['a null entry', null], ['an entry with no tag_name', {}]]) {
        it(`refuses by name, never with a TypeError, for ${label}`, async function () {
            const getCryptoNode = sinon.stub().resolves()
            const ms = loadWithRemoteEntry(entry, getCryptoNode)
            try {
                await ms.installModule('node', 'bitcoin', 'mainnet', false)
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.not.be.instanceOf(TypeError)
                expect(err.message).to.include('There is no valid version to download for the bitcoin/mainnet node')
            }
            expect(getCryptoNode.called).to.equal(false)
        })
    }
})
