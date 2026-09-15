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

const { sinon, expect, makeNodeServiceStubs, loadNodeService, mounts, build } = require('./support/helpers')

describe("NodeService: buildCryptoNode()", function () {

    describe("blocks-dir persistence + mount-drift guard", function () {
        it('persists the env value to the config/node.local sidecar', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.readSidecarValue    = sinon.stub().resolves(undefined)
            stubs.upsertSidecarValues = sinon.stub()
            await build(stubs, { envBlocksDir: '/bigdisk' })
            expect(stubs.upsertSidecarValues.calledOnce).to.be.true
            const [sidecarPath, values] = stubs.upsertSidecarValues.firstCall.args
            expect(sidecarPath).to.equal('/config/node.local')
            expect(values).to.deep.equal({ XCHAIN_NODE_BLOCKS_DIR: '/bigdisk' })
        })

        it('does not rewrite the sidecar when it already holds the same value', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.readSidecarValue    = sinon.stub().resolves('/bigdisk')
            stubs.upsertSidecarValues = sinon.stub()
            await build(stubs, { envBlocksDir: '/bigdisk' })
            expect(stubs.upsertSidecarValues.called).to.be.false
        })

        it('falls back to the persisted sidecar value when the env var is absent', async function () {
            // A profile-less invocation must still mount the relocated stores
            // once the value has been persisted.
            const stubs = makeNodeServiceStubs()
            stubs.readSidecarValue = sinon.stub().resolves('/bigdisk')
            const args = await build(stubs, { envBlocksDir: null })
            expect(mounts(args)).to.include('/bigdisk/bitcoin/mainnet:/blocks')
            expect(mounts(args)).to.include('/bigdisk/bitcoin/mainnet-txindex:/root/.bitcoin/indexes/txindex')
        })

        it('refuses to replace a container whose bind mounts the new spec would drop', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.forceRemoveContainerByName = sinon.stub().resolves(true)
            stubs.getContainerBindMounts = sinon.stub().resolves([
                { source: '/data/node/dogecoin/mainnet', destination: '/root/.dogecoin' },
                { source: '/bigdisk/dogecoin/mainnet',   destination: '/root/.dogecoin/blocks' },
                { source: '/bigdisk/dogecoin/mainnet-txindex', destination: '/root/.dogecoin/indexes/txindex' }
            ])
            let threw = null
            try {
                await build(stubs, { envBlocksDir: null, coin: 'dogecoin', network: 'mainnet' })
            } catch (err) { threw = err }
            expect(String(threw)).to.include('Refusing to replace container')
            expect(String(threw)).to.include('XCHAIN_NODE_BLOCKS_DIR')
            expect(String(threw)).to.include('/root/.dogecoin/blocks')
            // The old container must be left running and no new one created.
            expect(stubs.forceRemoveContainerByName.called).to.be.false
            expect(stubs.execFile.getCalls().some(c => c.args[1][0] === 'run')).to.be.false
        })
    })
})

describe("NodeService: buildCryptoNode()", function () {

    describe("blocks-dir persistence + mount-drift guard", function () {
        it('replaces normally when the new spec keeps every existing bind mount', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.forceRemoveContainerByName = sinon.stub().resolves(true)
            stubs.getContainerBindMounts = sinon.stub().resolves([
                { source: '/data/node/bitcoin/mainnet', destination: '/root/.bitcoin' },
                { source: '/bigdisk/bitcoin/mainnet',   destination: '/blocks' },
                { source: '/bigdisk/bitcoin/mainnet-txindex', destination: '/root/.bitcoin/indexes/txindex' }
            ])
            const args = await build(stubs, { envBlocksDir: '/bigdisk' })
            expect(args).to.not.be.null
            expect(stubs.forceRemoveContainerByName.calledOnce).to.be.true
        })

        it('stops the previous daemon gracefully, with a flush budget, before force-removing it', async function () {
            // Regression: `docker rm -f` alone is SIGKILL, and a killed daemon
            // restarts at its last flushed block index (16 regtest blocks lost
            // on the v0.21.5.6 litecoind rehearsal, 2026-09-03).
            const stubs = makeNodeServiceStubs()
            stubs.stopContainerByName       = sinon.stub().resolves({ stopped: true, seconds: 4, killed: false })
            stubs.forceRemoveContainerByName = sinon.stub().resolves(true)
            const args = await build(stubs, { envBlocksDir: null })

            expect(stubs.stopContainerByName.calledOnce).to.be.true
            const [name, budget] = stubs.stopContainerByName.firstCall.args
            expect(name).to.equal('xchain-node-bitcoin-mainnet-node')
            expect(budget).to.be.a('number').and.to.be.at.least(300)
            expect(stubs.stopContainerByName.calledBefore(stubs.forceRemoveContainerByName)).to.be.true
            // The same budget applies to an operator's `docker stop` / `restart`.
            const stopTimeoutIdx = args.indexOf('--stop-timeout')
            expect(stopTimeoutIdx).to.be.greaterThan(-1)
            expect(args[stopTimeoutIdx + 1]).to.equal(String(budget))
        })
        it('treats an existing symlink at the blocks host path as provisioned (no mkdir)', async function () {
            // Regression: mkdirSync on an existing symlink surfaced a misleading
            // EACCES "failed to create"; ensureHostDir lstats first and skips.
            const stubs = makeNodeServiceStubs()
            stubs.fs.lstatSync = sinon.stub().returns({ isSymbolicLink: () => true })
            // Scoped to the blocks path: staging the build scaffold also creates
            // its own directory, and a blanket throw would fail there instead,
            // never reaching the case under test.
            stubs.fs.mkdirSync.withArgs(sinon.match(/bigdisk/)).throws(new Error('EACCES: permission denied'))
            const args = await build(stubs, { envBlocksDir: '/bigdisk' })
            expect(args).to.not.be.null
            expect(stubs.fs.mkdirSync.calledWith(sinon.match(/bigdisk/))).to.be.false
        })
    })
})

describe("NodeService: buildCryptoNode()", function () {

    describe('blocks-dir persistence + mount-drift guard', function () {
        describe('stop budget and its outcome', function () {
            // A mainnet bitcoind killed at the budget came back 17000 blocks
            // lower and re-validated for four hours, and the update said nothing.
            let savedEnv, logStub, warnStub
            beforeEach(function () {
                savedEnv = process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS
                logStub  = sinon.stub(console, 'log')
                warnStub = sinon.stub(console, 'warn')
            })
            afterEach(function () {
                if (savedEnv === undefined) delete process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS
                else process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS = savedEnv
                logStub.restore()
                warnStub.restore()
            })

            it('takes the budget from XCHAIN_NODE_STOP_TIMEOUT_SECONDS and stamps it on the new container', async function () {
                process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS = '1800'
                const stubs = makeNodeServiceStubs()
                stubs.stopContainerByName = sinon.stub().resolves({ stopped: true, seconds: 900, killed: false })
                const args = await build(stubs, { envBlocksDir: null })
                expect(stubs.stopContainerByName.firstCall.args[1]).to.equal(1800)
                expect(args[args.indexOf('--stop-timeout') + 1]).to.equal('1800')
            })

            it('falls back to the default on a value that is not a whole number of seconds, and says so', async function () {
                process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS = 'ten minutes'
                const stubs = makeNodeServiceStubs()
                stubs.stopContainerByName = sinon.stub().resolves({ stopped: true, seconds: 1, killed: false })
                await build(stubs, { envBlocksDir: null })
                const ns = loadNodeService(stubs)
                expect(stubs.stopContainerByName.firstCall.args[1]).to.equal(ns.DEFAULT_NODE_STOP_TIMEOUT_SECONDS)
                expect(warnStub.args.some(a => /XCHAIN_NODE_STOP_TIMEOUT_SECONDS=ten minutes/.test(String(a[0])))).to.be.true
            })

            it('reports a clean stop with the time it took and the budget', async function () {
                const stubs = makeNodeServiceStubs()
                stubs.stopContainerByName = sinon.stub().resolves({ stopped: true, seconds: 42, killed: false })
                await build(stubs, { envBlocksDir: null })
                expect(logStub.args.some(a => /Stopped the bitcoin mainnet daemon cleanly in 42 s \(budget 600 s\)/.test(String(a[0])))).to.be.true
                expect(warnStub.args.some(a => /killed/.test(String(a[0])))).to.be.false
            })
        })
    })
})

describe("NodeService: buildCryptoNode()", function () {

    describe('blocks-dir persistence + mount-drift guard', function () {
        describe('stop budget and its outcome', function () {
            // A mainnet bitcoind killed at the budget came back 17000 blocks
            // lower and re-validated for four hours, and the update said nothing.
            let savedEnv, logStub, warnStub
            beforeEach(function () {
                savedEnv = process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS
                logStub  = sinon.stub(console, 'log')
                warnStub = sinon.stub(console, 'warn')
            })
            afterEach(function () {
                if (savedEnv === undefined) delete process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS
                else process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS = savedEnv
                logStub.restore()
                warnStub.restore()
            })
            it('warns when the daemon ran out of budget and was killed, naming the override', async function () {
                const stubs = makeNodeServiceStubs()
                stubs.stopContainerByName = sinon.stub().resolves({ stopped: true, seconds: 600, killed: true })
                await build(stubs, { envBlocksDir: null })
                const warning = warnStub.args.map(a => String(a[0])).find(l => /was killed/.test(l))
                expect(warning).to.match(/did not exit within the 600 s budget/)
                expect(warning).to.match(/re-validate/)
                expect(warning).to.match(/XCHAIN_NODE_STOP_TIMEOUT_SECONDS/)
            })

            it('says nothing about the stop when there was no previous daemon', async function () {
                const stubs = makeNodeServiceStubs()
                stubs.stopContainerByName = sinon.stub().resolves({ stopped: false, seconds: 0, killed: false })
                await build(stubs, { envBlocksDir: null })
                expect(logStub.args.some(a => /daemon cleanly/.test(String(a[0])))).to.be.false
                expect(warnStub.args.some(a => /was killed/.test(String(a[0])))).to.be.false
            })
        })
    })
})
