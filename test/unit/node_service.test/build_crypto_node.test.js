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

const { sinon, expect, makeNodeServiceStubs, loadNodeService, makeFakeHttps } = require('./support/helpers')

describe("NodeService: buildCryptoNode()", function () {

    it('runs docker build with correct image name and cwd', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'a'.repeat(64)

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.buildCryptoNode('bitcoin', 'mainnet')

        const buildCall = stubs.execFile.getCalls().find(c => c.args[1][0] === 'build')
        expect(buildCall).to.exist
        expect(buildCall.args[1]).to.include('-t')
        expect(buildCall.args[1]).to.include('xchain-node-bitcoin-mainnet-node')
        expect(result).to.equal(containerId)
    })

    it('stores container ID and fires statusChanged on success', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'b'.repeat(64)

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(stubs.db.setModuleContainer.calledOnce).to.be.true
        const insertArgs = stubs.db.setModuleContainer.firstCall.args
        expect(insertArgs[0]).to.equal('node')
        expect(insertArgs[1]).to.equal('bitcoin')
        expect(insertArgs[2]).to.equal('mainnet')
        expect(insertArgs[3]).to.equal(containerId)
        expect(stubs.statusChanged.calledOnce).to.be.true
    })
})

describe("NodeService: buildCryptoNode()", function () {

    it('includes port mapping when NODE_EXPOSED_PORT and NODE_PORT are configured', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'c'.repeat(64)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.include('-p')
        expect(runArgs).to.include('8333:8332')
    })

    // No caller ever passed a version, so the container carried the literal
    // string CRYPTO_NODE_VERSION=null and nothing anywhere read it
    // (uuid:1d4208f4). The version answer is /<coin>/__VERSION__.txt.
    it('bakes no CRYPTO_NODE_VERSION env into the coin-node container', async function () {
        const stubs = makeNodeServiceStubs()
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, 'f'.repeat(64) + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.not.be.null
        expect(runArgs.some(a => String(a).startsWith('CRYPTO_NODE_VERSION'))).to.be.false
        expect(runArgs.some(a => String(a).includes('null'))).to.be.false
        // The image tag still closes the argv, so this is not passing on a
        // truncated run call.
        expect(runArgs[runArgs.length - 1]).to.equal('xchain-node-bitcoin-mainnet-node')
        expect(runArgs[runArgs.length - 2]).to.equal('-t')
    })
})

describe("NodeService: buildCryptoNode()", function () {

    it('aborts before the docker build when a host-port conflict is detected', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.assertNoHostPortConflicts = sinon.stub().rejects(
            new Error('Host port conflict: host port 8333 is already published by: other-stack-bitcoin-mainnet-node'))
        let built = false
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') { built = true; return cb(null) }
            if (args[0] === 'run')   return cb(null, 'e'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        let threw = null
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
        } catch (err) { threw = err }
        expect(threw).to.be.an.instanceOf(Error)
        expect(threw.message).to.include('Host port conflict')
        // The guard runs before the build, so `docker build` must NOT fire.
        expect(built).to.be.false
    })
})

describe("NodeService: buildCryptoNode()", function () {

    it('rejects when docker run fails', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(new Error('run failed'), '')
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).to.include('Error creating the container')
        }
    })

    it('rejects when db.setModuleContainer returns false', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.db.setModuleContainer.resolves(false)
        const containerId = 'e'.repeat(64)

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).to.include("problem trying to store")
        }
    })

    it('rejects (does not hang) when the docker build fails', async function () {
        // A bare return from the build-error callback leaves the Promise unsettled
        // and buildCryptoNode hanging. The mocha timeout makes that failure visible.
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(new Error('build blew up'))
            if (args[0] === 'run')   return cb(null, 'a'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Error creating Docker image')
        }
        // run must never have been attempted after a build failure
        expect(stubs.execFile.getCalls().some(c => c.args[1][0] === 'run')).to.be.false
    })
})

describe("NodeService: buildCryptoNode()", function () {

    it('rejects (does not hang) when docker run output is not a container id', async function () {
        // Regression: when `docker run` exited 0 but stdout was not a 64-hex id,
        // there was no else branch; the Promise never settled and hung forever.
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'WARNING: something\n') // not a container id
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('no container id')
        }
        expect(stubs.db.setModuleContainer.called).to.be.false
    })

    it('rejects (does not hang) when the blocksDir mkdir fails', async function () {
        this.timeout(5000)
        // Throwing from the XCHAIN_NODE_BLOCKS_DIR mkdir failure path inside the
        // docker-build callback escapes the Promise as an uncaught exception and
        // leaves buildCryptoNode hanging. It must reject instead.
        // NOTE: the build callback is invoked ASYNCHRONOUSLY here (as real execFile
        // does); a synchronous stub would let the throw be captured by the Promise
        // executor and mask the bug.
        const stubs = makeNodeServiceStubs()
        // Scoped to the blocks path (see the symlink case above): a blanket throw
        // trips staging the build scaffold first and never reaches this guard.
        stubs.fs.mkdirSync.withArgs(sinon.match(/^\/blocks/)).throws(new Error('EACCES: permission denied'))
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return setImmediate(() => cb(null))
            if (args[0] === 'run')   return setImmediate(() => cb(null, 'a'.repeat(64) + '\n'))
        })

        const oldBlocksDir = process.env.XCHAIN_NODE_BLOCKS_DIR
        process.env.XCHAIN_NODE_BLOCKS_DIR = '/blocks'
        try {
            const ns = loadNodeService(stubs)
            try {
                await ns.buildCryptoNode('bitcoin', 'mainnet')
                expect.fail('Should have rejected')
            } catch (err) {
                expect(String(err)).to.include('XCHAIN_NODE_BLOCKS_DIR')
                expect(String(err)).to.include('failed to create')
            }
            // docker run must never be attempted once the blocks dir cannot be made
            expect(stubs.execFile.getCalls().some(c => c.args[1][0] === 'run')).to.be.false
        } finally {
            if (oldBlocksDir === undefined) delete process.env.XCHAIN_NODE_BLOCKS_DIR
            else process.env.XCHAIN_NODE_BLOCKS_DIR = oldBlocksDir
        }
    })
})

describe("NodeService: buildCryptoNode()", function () {

    it('reads and rewrites conf file when it exists', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'f'.repeat(64)
        stubs.fs.existsSync.returns(true)  // conf file exists
        stubs.fs.readFileSync.returns('rpcuser=olduser\nrpcpassword=oldpass\n')

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(stubs.fs.readFileSync.calledOnce).to.be.true
        expect(stubs.fs.writeFileSync.calledOnce).to.be.true
        const writtenContent = stubs.fs.writeFileSync.firstCall.args[1]
        expect(writtenContent).to.include('rpcuser=testuser')
        expect(writtenContent).to.include('rpcpassword=testpass')
    })

    it('includes --ulimit nofile flag in docker run args', async function () {
        const stubs = makeNodeServiceStubs()
        // Must be valid hex [a-f0-9]{64}; buildCryptoNode checks the regex before resolving
        const containerId = 'deadbeef'.repeat(8)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.include('--ulimit')
        expect(runArgs).to.include('nofile=2048:2048')
    })

    it('includes --restart unless-stopped in docker run args', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'cafebabe'.repeat(8)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.include('--restart')
        expect(runArgs).to.include('unless-stopped')
    })
})
