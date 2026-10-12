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

// The CLI install and update reach the daemon through installModule('node'),
// so XCHAIN_NODE_NODE_VERSION_<COIN> has to bind there exactly as it does for
// the menu's installNode, or the pin a harness sets is silently ignored.

const { sinon, expect, makeStubs, loadModuleService, moduleSuite } = require('./support/helpers')

const PIN_ENV = 'XCHAIN_NODE_NODE_VERSION_BITCOIN'

// Loads ModuleService with a remote latest of v28.1 and the given cached daemon.
function loadWith(localVersion) {
    const stubs = makeStubs()
    const getCryptoNode = sinon.stub().resolves()
    const checkRemoteNodeVersion = sinon.stub().resolves()
    const ms = loadModuleService(stubs, undefined, {
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({ 'node-bitcoin': { tag_name: 'v28.1' } }),
            getLastStatus: () => null
        },
        './version_service': {
            getLocalNodeVersion: sinon.stub().resolves(localVersion),
            getLocalModuleVersion: sinon.stub().resolves(null),
            checkRemoteNodeVersion
        },
        './node_service': {
            buildCryptoNode: sinon.stub().resolves(true),
            getCryptoNode
        }
    })
    return { ms, getCryptoNode, checkRemoteNodeVersion }
}

moduleSuite('installModule(): node: XCHAIN_NODE_NODE_VERSION_<COIN> pin', function () {
    afterEach(function () { delete process.env[PIN_ENV] })

    it('an update downloads the pinned tag, not the latest release', async function () {
        process.env[PIN_ENV] = 'v27.0'
        const { ms, getCryptoNode } = loadWith('28.1\n')
        await ms.installModule('node', 'bitcoin', 'mainnet', true)
        expect(getCryptoNode.calledOnceWith('bitcoin', 'mainnet', 'v27.0')).to.equal(true)
    })

    it('a fresh install downloads the pinned tag', async function () {
        process.env[PIN_ENV] = 'v27.0'
        const { ms, getCryptoNode } = loadWith(null)
        await ms.installModule('node', 'bitcoin', 'mainnet', false)
        expect(getCryptoNode.calledOnceWith('bitcoin', 'mainnet', 'v27.0')).to.equal(true)
    })

    it('refuses to reuse a cached daemon that differs from the pin', async function () {
        process.env[PIN_ENV] = 'v27.0'
        const { ms, getCryptoNode } = loadWith('28.1\n')
        try {
            await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect.fail('should have thrown')
        } catch (err) {
            expect(err.message).to.match(/pins v27\.0/)
        }
        expect(getCryptoNode.called).to.equal(false)
    })

    it('reuses a cached bare-version daemon that matches a v-tagged pin', async function () {
        process.env[PIN_ENV] = 'v28.1'
        const { ms, getCryptoNode } = loadWith('28.1\n')
        expect(await ms.installModule('node', 'bitcoin', 'mainnet', false)).to.equal(true)
        expect(getCryptoNode.called).to.equal(false)
    })

    it('with no pin, an update still takes the latest release', async function () {
        const { ms, getCryptoNode } = loadWith('27.0\n')
        await ms.installModule('node', 'bitcoin', 'mainnet', true)
        expect(getCryptoNode.calledOnceWith('bitcoin', 'mainnet', 'v28.1')).to.equal(true)
    })
})
