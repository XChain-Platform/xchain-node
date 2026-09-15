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

const { sinon, expect, makeNodeServiceStubs, loadNodeService } = require('./support/helpers')

describe("NodeService: node version pin (XCHAIN_NODE_NODE_VERSION_<COIN>)", function () {

    afterEach(function () {
        delete process.env.XCHAIN_NODE_NODE_VERSION_LITECOIN
    })
    it('resolveNodeVersionPin returns null when env unset or blank', function () {
        const ns = loadNodeService(makeNodeServiceStubs())
        expect(ns.resolveNodeVersionPin('litecoin')).to.equal(null)
        process.env.XCHAIN_NODE_NODE_VERSION_LITECOIN = '   '
        expect(ns.resolveNodeVersionPin('litecoin')).to.equal(null)
    })

    it('resolveNodeVersionPin returns the trimmed pin for the coin', function () {
        process.env.XCHAIN_NODE_NODE_VERSION_LITECOIN = ' v0.21.4 '
        const ns = loadNodeService(makeNodeServiceStubs())
        expect(ns.resolveNodeVersionPin('litecoin')).to.equal('v0.21.4')
        // Other coins remain unpinned
        expect(ns.resolveNodeVersionPin('bitcoin')).to.equal(null)
    })

    it('assertNodeVersionPin throws on a mismatched local daemon', function () {
        const ns = loadNodeService(makeNodeServiceStubs())
        expect(() => ns.assertNodeVersionPin('litecoin', 'regtest', 'v0.21.3', 'v0.21.4'))
            .to.throw(/pins v0\.21\.4/)
        // No pin, or matching version, or nothing installed: no throw
        expect(() => ns.assertNodeVersionPin('litecoin', 'regtest', 'v0.21.3', null)).to.not.throw()
        expect(() => ns.assertNodeVersionPin('litecoin', 'regtest', 'v0.21.4', 'v0.21.4')).to.not.throw()
        expect(() => ns.assertNodeVersionPin('litecoin', 'regtest', null, 'v0.21.4')).to.not.throw()
    })
})

describe("NodeService: node version pin (XCHAIN_NODE_NODE_VERSION_<COIN>)", function () {

    afterEach(function () {
        delete process.env.XCHAIN_NODE_NODE_VERSION_LITECOIN
    })
    it('installNode downloads the pinned version, bypassing remote-latest lookup', async function () {
        process.env.XCHAIN_NODE_NODE_VERSION_LITECOIN = 'v0.21.4'
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves(null),
            getDockerContainerImageName: sinon.stub().returns('xchain-node-litecoin-regtest-node'),
            getDockerNetwork:            sinon.stub().returns('xchain-node-litecoin-regtest')
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'f'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('litecoin', 'regtest')
        expect(result).to.be.true
        // Downloaded exactly the pinned tag
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
        expect(stubs.gitHubDownloader.downloadRepoVersion.firstCall.args[2]).to.equal('v0.21.4')
        // Never consulted GitHub for the latest release
        expect(stubs.checkRemoteNodeVersion.called).to.be.false
    })

    it('installNode fails loudly when a cached local daemon mismatches the pin', async function () {
        process.env.XCHAIN_NODE_NODE_VERSION_LITECOIN = 'v0.21.4'
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('v0.21.3')
        })
        const ns = loadNodeService(stubs)
        try {
            await ns.installNode('litecoin', 'regtest')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/pins v0\.21\.4/)
        }
    })
})
