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

const { sinon, expect, makeNodeServiceStubs, build } = require('./support/helpers')

describe('NodeService: buildCryptoNode() datadir source guard', function () {
    it('leaves the existing container untouched when the datadir source changes', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.forceRemoveContainerByName = sinon.stub().resolves(true)
        stubs.stopContainerByName = sinon.stub().resolves({ stopped: true, seconds: 1, killed: false })
        stubs.getContainerBindMounts = sinon.stub().resolves([
            { source: '/carrier-a/node/bitcoin/mainnet', destination: '/root/.bitcoin' }
        ])

        let threw = null
        try {
            await build(stubs, { envBlocksDir: null })
        } catch (err) { threw = err }

        expect(String(threw)).to.include('Refusing to replace container')
        expect(String(threw)).to.include('bind mount source')
        expect(String(threw)).to.include('/carrier-a/node/bitcoin/mainnet')
        expect(String(threw)).to.include('/data/node/bitcoin/mainnet')
        expect(stubs.stopContainerByName.called).to.be.false
        expect(stubs.forceRemoveContainerByName.called).to.be.false
        expect(stubs.execFile.getCalls().some(call => call.args[1][0] === 'run')).to.be.false
    })
})
