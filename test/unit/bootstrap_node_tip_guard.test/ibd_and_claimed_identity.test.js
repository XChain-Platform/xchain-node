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

// The node tip guard against the services' own wait rule (initial block
// download only) and against an archive claiming another target.

const sinon      = require('sinon')
const { expect } = require('chai')

const guard = require('../../../src/services/bootstrap_node_tip_guard')
const { XChainService } = require('../../../src/config')

const DECODER = XChainService.XCHAIN_DECODER
const TRACKER = XChainService.XCHAIN_UTXO_TRACKER
const INDEXER = XChainService.XCHAIN_INDEXER
let logs, logStub

function setupLogCapture() {
    logs = []
    logStub = sinon.stub(console, 'log').callsFake((...args) => logs.push(args.join(' ')))
    delete process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD
}

function cleanupLogCapture() {
    logStub.restore()
    delete process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD
}

// The decoder and tracker wait out a lower node tip only while the node reports
// initial block download; out of it they read the gap as a rollback.
describe('BootstrapNodeTipGuard', function () {
    beforeEach(setupLogCapture)
    afterEach(cleanupLogCapture)

    describe('a node below the archive but out of initial block download', function () {
        const settledBehind = { blocks: 962304, headers: 964980, initialblockdownload: false }
        const archive = async () => ({ format: 1, height: 964970 })

        it('refuses the decoder and tracker even when the image waits, without blaming the image', function () {
            for (const module of [DECODER, TRACKER]) {
                const r = guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: settledBehind, serviceWaits: true, module })
                expect(r.verdict, module).to.equal('behind-refuse')
                expect(r).to.include({ ibd: false, gap: 2666 })
                expect(r.detail).to.match(/not in initial block download/)
                expect(r.detail).to.match(/XCHAIN_NODE_FORCE_BOOTSTRAP=1/)
                expect(r.detail).to.match(/--no-bootstrap/)
                expect(r.detail).to.not.match(/WAITING FOR NODE|does not wait out a catching-up node/)
            }
        })

        it('still passes the indexer, which follows the decoder', function () {
            const r = guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: settledBehind, serviceWaits: true, module: INDEXER })
            expect(r.verdict).to.equal('behind-wait')
        })

        it('refuses through the assessment without probing the service or the version', async function () {
            const probe = sinon.stub().resolves({ status: 'healthy', node_catching_up: null })
            const version = sinon.stub().resolves('0.16.0')
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: async () => settledBehind,
                probeServiceCapability: probe, getLocalModuleVersion: version
            })
            expect(r.verdict).to.equal('behind-refuse')
            expect(r.refuse).to.equal(true)
            expect(probe.called).to.equal(false)
            expect(version.called).to.equal(false)
            expect(logs.join('\n')).to.not.match(/^REFUSING the|WAITING FOR NODE/m)
        })

        it('keeps the indexer restoring through the assessment', async function () {
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: INDEXER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: async () => settledBehind
            })
            expect(r.verdict).to.equal('behind-wait')
            expect(r.refuse).to.equal(false)
        })
    })
})

// bootstrap.json is read before the signature check, so a claimed identity for
// another target only stops the comparison; it never refuses.
describe('BootstrapNodeTipGuard', function () {
    beforeEach(setupLogCapture)
    afterEach(cleanupLogCapture)

    describe('assessNodeTipForRestore() and the archive\'s claimed identity', function () {
        const behindNode = async () => ({ blocks: 962304, headers: 964980, initialblockdownload: true })
        const claimed = (fields) => async () => ({ format: 1, module: DECODER, coin: 'bitcoin', network: 'mainnet', height: 964970, ...fields })
        const target = { coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }

        it('is unknown, never a refusal, for an archive claiming another module, coin or network, and asks nothing', async function () {
            for (const fields of [{ module: TRACKER }, { coin: 'litecoin' }, { network: 'testnet' }]) {
                const node = sinon.stub().callsFake(behindNode)
                const probe = sinon.stub().resolves({ node_catching_up: null })
                const r = await guard.assessNodeTipForRestore(target, { readBootstrapArchiveMeta: claimed(fields), readCoinNodeChainInfo: node, probeServiceCapability: probe })
                const [field, value] = Object.entries(fields)[0]
                expect(r.verdict, field).to.equal('unknown')
                expect(r.refuse).to.equal(false)
                expect(r.detail).to.include(`${field} ${value} (unverified)`)
                expect(node.called).to.equal(false)
                expect(probe.called).to.equal(false)
            }
            expect(logs.join('\n')).to.match(/^Note: the archive's bootstrap\.json declares/m)
        })

        it('compares the height as before for a matching or converter-shape archive', async function () {
            const deps = { readCoinNodeChainInfo: behindNode, probeServiceCapability: async () => ({ node_catching_up: null }) }
            const full = await guard.assessNodeTipForRestore(target, { ...deps, readBootstrapArchiveMeta: claimed({}) })
            const converter = await guard.assessNodeTipForRestore(target, { ...deps, readBootstrapArchiveMeta: claimed({ coin: null, network: null }) })
            expect(full.verdict).to.equal('behind-wait')
            expect(converter.verdict).to.equal('behind-wait')
        })
    })
})
