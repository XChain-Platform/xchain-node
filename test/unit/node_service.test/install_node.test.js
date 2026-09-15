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

// installNode() exercises orchestration branches that are required lazily, so
// the tests below reach them by overriding the lazy stubs loadNodeService()
// installs rather than by rebuilding the proxyquire wiring in full.
describe("NodeService: installNode()", function () {

    it('succeeds when local node version already installed (skips getCryptoNode)', async function () {
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0')
        })
        // Make execFile no-op (buildCryptoNode still calls it)
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'a'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('bitcoin', 'mainnet')
        expect(result).to.be.true
        // gitHubDownloader should NOT have been called; version was local
        expect(stubs.gitHubDownloader.downloadRepoVersion.called).to.be.false
    })

    it('fetches remote version and calls getCryptoNode when not installed (dogecoin)', async function () {
        // Use dogecoin so getCryptoNode goes through gitHubDownloader (fully stubbed)
        // rather than https.get (bitcoin), which requires a live fake HTTP server
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves(null),
            getRemoteModuleVersions: () => ({
                'node-dogecoin': { tag_name: 'v1.14.7' }
            }),
            getDefaultConfig: sinon.stub().resolves({
                NODE_EXPOSED_PORT: 22556,
                NODE_PORT:         22555,
                NODE_USER:         'testuser',
                NODE_PASSWORD:     'testpass'
            }),
            getDockerContainerImageName: sinon.stub().returns('xchain-node-dogecoin-mainnet-node'),
            getDockerNetwork:            sinon.stub().returns('xchain-node-dogecoin-mainnet')
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'b'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('dogecoin', 'mainnet')
        expect(result).to.be.true
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
    })
})

describe("NodeService: installNode()", function () {

    it('throws when no valid remote version is available', async function () {
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves(null),
            getRemoteModuleVersions: () => ({
                'node-bitcoin': { tag_name: null }
            })
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.installNode('bitcoin', 'mainnet')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/no valid version/)
        }
    })
})

describe("NodeService: installNode()", function () {

    it('installs regtest miner when network is regtest', async function () {
        // Capture what the ModuleService.cloneGit stub was called with
        const cloneGitStub = sinon.stub().resolves(true)
        const buildAndUpStub = sinon.stub().resolves('c'.repeat(64))
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0'),
            cloneGit: cloneGitStub,
            buildAndUp: buildAndUpStub
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'c'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('bitcoin', 'regtest')
        expect(result).to.be.true
        const clonedModules = cloneGitStub.getCalls().map(c => c.args[0])
        expect(clonedModules).to.include('xchain-regtest-miner')
    })
})

describe("NodeService: installNode()", function () {

    it('does NOT install regtest miner when network is mainnet', async function () {
        const cloneGitStub  = sinon.stub().resolves(true)
        const buildAndUpStub = sinon.stub().resolves('d'.repeat(64))
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0'),
            cloneGit: cloneGitStub,
            buildAndUp: buildAndUpStub
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'd'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('bitcoin', 'mainnet')
        expect(result).to.be.true
        const clonedModules = cloneGitStub.getCalls().map(c => c.args[0])
        expect(clonedModules).to.not.include('xchain-regtest-miner')
    })
})

describe("NodeService: installNode()", function () {

    it('bootstraps utxo tracker when volume is fresh', async function () {
        const ensureBootstrap = sinon.stub().resolves()
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0'),
            utxoTrackerVolumeFreshness: sinon.stub().resolves('empty'), // confirmed fresh
            ensureBootstrapUtxoTracker: ensureBootstrap
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'e'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        await ns.installNode('bitcoin', 'mainnet')
        expect(ensureBootstrap.calledOnce).to.be.true
    })
})
