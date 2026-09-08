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

// The restore-time comparison between a bootstrap archive's end height and
// the coin node's tip. Pinned: the four verdicts, how "does the
// service wait" is decided, and that the whole assessment never throws.

const sinon      = require('sinon')
const { expect } = require('chai')

const guard = require('../../src/services/BootstrapNodeTipGuard')
const { XChainService } = require('../../src/config/constants')

const DECODER = XChainService.XCHAIN_DECODER
const TRACKER = XChainService.XCHAIN_UTXO_TRACKER
const INDEXER = XChainService.XCHAIN_INDEXER

describe('BootstrapNodeTipGuard', function () {
    let logs
    let logStub
    beforeEach(function () {
        logs = []
        logStub = sinon.stub(console, 'log').callsFake((...args) => logs.push(args.join(' ')))
        delete process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD
    })
    afterEach(function () {
        logStub.restore()
        delete process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD
    })

    describe('evaluateNodeTipAgainstArchive()', function () {
        it('is unknown without an archive height, and says why', function () {
            const r = guard.evaluateNodeTipAgainstArchive({ archiveHeight: null, chainInfo: { blocks: 5 }, serviceWaits: true, module: DECODER })
            expect(r.verdict).to.equal('unknown')
            expect(r.detail).to.match(/no end height/)
        })

        it('is unknown without a node answer, naming the archive height', function () {
            const r = guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: null, serviceWaits: true, module: DECODER })
            expect(r.verdict).to.equal('unknown')
            expect(r.detail).to.match(/964970/)
        })

        it('is ok when the node is at or past the archive', function () {
            expect(guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: { blocks: 964970 }, serviceWaits: false, module: DECODER }).verdict).to.equal('ok')
            expect(guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: { blocks: 970000 }, serviceWaits: false, module: DECODER }).verdict).to.equal('ok')
        })

        it('is behind-wait when the node is below and the service waits, with the gap and the ps marker in the detail', function () {
            const r = guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: { blocks: 962304, initialblockdownload: true }, serviceWaits: true, module: DECODER })
            expect(r.verdict).to.equal('behind-wait')
            expect(r).to.include({ archiveHeight: 964970, nodeHeight: 962304, gap: 2666, ibd: true })
            expect(r.detail).to.match(/962304 \(initial block download\), 2666 blocks below the archive's 964970/)
            expect(r.detail).to.match(/WAITING FOR NODE/)
        })

        it('is behind-refuse when the service does not wait, and the detail names both recoveries', function () {
            const r = guard.evaluateNodeTipAgainstArchive({ archiveHeight: 964970, chainInfo: { blocks: 100, initialblockdownload: false }, serviceWaits: false, module: TRACKER })
            expect(r.verdict).to.equal('behind-refuse')
            expect(r.detail).to.not.match(/initial block download\)/)
            expect(r.detail).to.match(/read the node's lower tip as a reorg and halt/)
            expect(r.detail).to.match(/XCHAIN_NODE_FORCE_BOOTSTRAP=1/)
            expect(r.detail).to.match(/--no-bootstrap/)
        })
    })

    describe('serviceWaitsOutCatchUp()', function () {
        it('the indexer always passes: it follows the decoder, not the node', function () {
            expect(guard.serviceWaitsOutCatchUp(INDEXER, { statusPayload: {}, version: '0.1.0' })).to.equal(true)
        })

        it('a status payload that carries node_catching_up (even null) is the capability', function () {
            expect(guard.serviceWaitsOutCatchUp(DECODER, { statusPayload: { status: 'healthy', node_catching_up: null } })).to.equal(true)
            expect(guard.serviceWaitsOutCatchUp(TRACKER, { statusPayload: { status: 'healthy', node_catching_up: { node_height: 1 } } })).to.equal(true)
        })

        it('a readable payload WITHOUT the field decides against, whatever the version says', function () {
            expect(guard.serviceWaitsOutCatchUp(DECODER, { statusPayload: { status: 'healthy' }, version: '0.16.0' })).to.equal(false)
        })

        it('falls back to the version when the payload is unreadable: 0.16.0 is the first that waits', function () {
            expect(guard.serviceWaitsOutCatchUp(DECODER, { statusPayload: null, version: '0.16.0' })).to.equal(true)
            expect(guard.serviceWaitsOutCatchUp(DECODER, { statusPayload: null, version: 'v0.17.2' })).to.equal(true)
            expect(guard.serviceWaitsOutCatchUp(DECODER, { statusPayload: null, version: '1.0.0' })).to.equal(true)
            expect(guard.serviceWaitsOutCatchUp(TRACKER, { statusPayload: null, version: '0.15.5' })).to.equal(false)
            expect(guard.serviceWaitsOutCatchUp(TRACKER, { statusPayload: null, version: 'garbage' })).to.equal(false)
            expect(guard.serviceWaitsOutCatchUp(TRACKER, { statusPayload: null, version: null })).to.equal(false)
        })
    })

    describe('readCoinNodeChainInfo()', function () {
        it('runs the coin CLI inside the registered node container with the image\'s conf arguments', async function () {
            const runner = sinon.stub().resolves({ stdout: JSON.stringify({ blocks: 962304, headers: 964980, initialblockdownload: true }) })
            const getModuleContainer = sinon.stub().resolves('node-cid')
            const info = await guard.readCoinNodeChainInfo('bitcoin', 'mainnet', { runner, getModuleContainer })
            expect(info).to.deep.equal({ blocks: 962304, headers: 964980, initialblockdownload: true })
            expect(getModuleContainer.firstCall.args).to.deep.equal(['node', 'bitcoin', 'mainnet'])
            expect(runner.firstCall.args[0]).to.equal('docker')
            expect(runner.firstCall.args[1]).to.deep.equal(['exec', 'node-cid', 'bitcoin-cli', '-conf=/etc/bitcoin/bitcoin.conf', '-datadir=/root/.bitcoin/', 'getblockchaininfo'])
        })

        it('reads a missing initialblockdownload as false and a missing headers as null', async function () {
            const runner = sinon.stub().resolves({ stdout: '{"blocks": 10}' })
            const info = await guard.readCoinNodeChainInfo('dogecoin', 'testnet', { runner, getModuleContainer: async () => 'cid' })
            expect(info).to.deep.equal({ blocks: 10, headers: null, initialblockdownload: false })
            expect(runner.firstCall.args[1][2]).to.equal('dogecoin-cli')
        })

        it('throws with a reason for an unknown coin, a missing container, and a non-JSON answer', async function () {
            const rejection = async (promise) => {
                try { await promise } catch (err) { return err.message }
                throw new Error('expected a rejection')
            }
            expect(await rejection(guard.readCoinNodeChainInfo('monero', 'mainnet', { runner: async () => ({ stdout: '{}' }), getModuleContainer: async () => 'cid' })))
                .to.match(/no node CLI known/)
            expect(await rejection(guard.readCoinNodeChainInfo('bitcoin', 'mainnet', { runner: async () => ({ stdout: '{}' }), getModuleContainer: async () => null })))
                .to.match(/no bitcoin\/mainnet node container/)
            expect(await rejection(guard.readCoinNodeChainInfo('bitcoin', 'mainnet', { runner: async () => ({ stdout: 'error: couldn\'t connect' }), getModuleContainer: async () => 'cid' })))
                .to.match(/did not return JSON/)
            expect(await rejection(guard.readCoinNodeChainInfo('bitcoin', 'mainnet', { runner: async () => ({ stdout: '{"chain":"main"}' }), getModuleContainer: async () => 'cid' })))
                .to.match(/no usable block height/)
        })
    })

    describe('assessNodeTipForRestore()', function () {
        const behindNode = async () => ({ blocks: 962304, headers: 964980, initialblockdownload: true })
        const archive = async () => ({ format: 1, height: 964970 })

        it('restores with a warning when the service publishes node_catching_up', async function () {
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: behindNode,
                probeServiceCapability: async () => ({ status: 'healthy', node_catching_up: null })
            })
            expect(r.verdict).to.equal('behind-wait')
            expect(r.refuse).to.equal(false)
            expect(logs.join('\n')).to.match(/^WARNING: the coin node is at 962304/m)
        })

        it('refuses when the running service lacks the field', async function () {
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: TRACKER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: behindNode,
                probeServiceCapability: async () => ({ status: 'healthy', lag: 0 })
            })
            expect(r.verdict).to.equal('behind-refuse')
            expect(r.refuse).to.equal(true)
            expect(logs.join('\n')).to.match(/^REFUSING the xchain-utxo-tracker bootstrap restore/m)
        })

        it('falls back to the module version when the service cannot be probed', async function () {
            const old = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: behindNode,
                probeServiceCapability: async () => null, getLocalModuleVersion: async () => '0.15.5'
            })
            expect(old.verdict).to.equal('behind-refuse')
            const fixed = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: behindNode,
                probeServiceCapability: async () => null, getLocalModuleVersion: async () => '0.16.0'
            })
            expect(fixed.verdict).to.equal('behind-wait')
            const unknownVersion = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: behindNode,
                probeServiceCapability: async () => null, getLocalModuleVersion: async () => { throw new Error('no package.json') }
            })
            expect(unknownVersion.verdict, 'an unreadable version cannot vouch for the wait').to.equal('behind-refuse')
        })

        it('never asks the service or the version for the indexer', async function () {
            const probe = sinon.stub().resolves({})
            const version = sinon.stub().resolves('0.1.0')
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: INDEXER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: behindNode,
                probeServiceCapability: probe, getLocalModuleVersion: version
            })
            expect(r.verdict).to.equal('behind-wait')
            expect(probe.called).to.equal(false)
            expect(version.called).to.equal(false)
        })

        it('is ok, quietly, when the node is past the archive, without probing the service', async function () {
            const probe = sinon.stub().resolves({})
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: async () => ({ blocks: 970000, initialblockdownload: false }),
                probeServiceCapability: probe
            })
            expect(r.verdict).to.equal('ok')
            expect(r.refuse).to.equal(false)
            expect(probe.called).to.equal(false)
            expect(logs.join('\n')).to.match(/970000 is at or past the archive height 964970/)
        })

        it('is unknown without archive metadata and does not ask the node at all', async function () {
            const node = sinon.stub().resolves({ blocks: 1 })
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: async () => null, readCoinNodeChainInfo: node
            })
            expect(r.verdict).to.equal('unknown')
            expect(r.refuse).to.equal(false)
            expect(node.called).to.equal(false)
            expect(logs.join('\n')).to.match(/^Note: the archive carries no end height/m)
        })

        it('is unknown when the node cannot be asked, carrying the reason, and never throws', async function () {
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: async () => { throw new Error('error code: -28 Loading block index') }
            })
            expect(r.verdict).to.equal('unknown')
            expect(r.refuse).to.equal(false)
            expect(r.detail).to.match(/Loading block index/)
        })

        it('survives a metadata reader that throws', async function () {
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: async () => { throw new Error('boom') }, readCoinNodeChainInfo: behindNode
            })
            expect(r.verdict).to.equal('unknown')
        })

        it('XCHAIN_NODE_SKIP_NODE_TIP_GUARD skips the comparison, loudly', async function () {
            process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD = '1'
            const node = sinon.stub().resolves({ blocks: 1 })
            const r = await guard.assessNodeTipForRestore({ coin: 'bitcoin', network: 'mainnet', module: DECODER, archivePath: '/x' }, {
                readBootstrapArchiveMeta: archive, readCoinNodeChainInfo: node
            })
            expect(r.verdict).to.equal('skipped')
            expect(r.refuse).to.equal(false)
            expect(node.called).to.equal(false)
            expect(logs.join('\n')).to.match(/WARNING: XCHAIN_NODE_SKIP_NODE_TIP_GUARD/)
        })
    })

    describe('probeServiceCapability()', function () {
        it('retries the status probe and returns the first payload', async function () {
            const probe = sinon.stub()
            probe.onFirstCall().rejects(new Error('connection refused'))
            probe.onSecondCall().resolves({ status: 'healthy', node_catching_up: null })
            const payload = await guard.probeServiceCapability(DECODER, 'bitcoin', 'mainnet', {
                getModuleContainer: async () => 'cid', getDefaultConfig: async () => ({ DECODER_API_PORT: '3002' }),
                probeServiceStatus: probe, attempts: 3, delayMs: 1
            })
            expect(payload).to.deep.equal({ status: 'healthy', node_catching_up: null })
            expect(probe.callCount).to.equal(2)
            expect(probe.firstCall.args.slice(0, 2)).to.deep.equal(['cid', '3002'])
        })

        it('answers null when every attempt fails, when the port is unknown, or when the container is missing', async function () {
            const failing = sinon.stub().rejects(new Error('refused'))
            expect(await guard.probeServiceCapability(DECODER, 'bitcoin', 'mainnet', {
                getModuleContainer: async () => 'cid', getDefaultConfig: async () => ({ DECODER_API_PORT: '3002' }),
                probeServiceStatus: failing, attempts: 2, delayMs: 1
            })).to.equal(null)
            expect(failing.callCount).to.equal(2)
            expect(await guard.probeServiceCapability(DECODER, 'bitcoin', 'mainnet', {
                getModuleContainer: async () => 'cid', getDefaultConfig: async () => ({}), probeServiceStatus: failing, attempts: 1, delayMs: 1
            })).to.equal(null)
            expect(await guard.probeServiceCapability(DECODER, 'bitcoin', 'mainnet', {
                getModuleContainer: async () => null, getDefaultConfig: async () => ({ DECODER_API_PORT: '3002' }), probeServiceStatus: failing, attempts: 1, delayMs: 1
            })).to.equal(null)
        })
    })

    describe('version parsing', function () {
        it('accepts a leading v and ignores a suffix', function () {
            expect(guard.parseSemver('v0.16.0-rc.1')).to.deep.equal([0, 16, 0])
            expect(guard.parseSemver('0.15.5')).to.deep.equal([0, 15, 5])
            expect(guard.parseSemver('develop')).to.equal(null)
            expect(guard.versionAtLeast('0.16.0', [0, 16, 0])).to.equal(true)
            expect(guard.versionAtLeast('0.15.9', [0, 16, 0])).to.equal(false)
        })
    })
})
