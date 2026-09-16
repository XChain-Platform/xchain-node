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

const { sinon, expect, makeNodeServiceStubs, loadNodeService, makeFakeHttps } = require('./node_service.test/support/helpers')

describe("NodeService: getCryptoNode()", function () {

    it('downloads bitcoin node for x64 arch, decompresses and renames', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.fs.existsSync.returns(false)   // no old bitcoin dir

        // Save original process.arch, then override via Object.defineProperty
        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })

        expect(stubs.decompressTarGz.calledOnce).to.be.true
        expect(stubs.fs.renameSync.calledOnce).to.be.true
        expect(stubs.fs.writeFileSync.calledOnce).to.be.true
    })

    it('uses rmSync when node version >= 14.14.0 and old bitcoin dir exists', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.fs.existsSync.returns(true)  // old dir exists

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })

        // node version >= 14.14 so rmSync must have been called
        expect(stubs.fs.rmSync.calledOnce).to.be.true
    })
})

describe("NodeService: getCryptoNode()", function () {

    it('throws on unsupported architecture', async function () {
        const stubs = makeNodeServiceStubs()
        // No https needed; should throw before download

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'mips', configurable: true })

        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/Unsupported architecture/)
        } finally {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        }
    })

    it('rejects when decompressTarGz fails', async function () {
        const stubs = makeNodeServiceStubs()
        const decompressErr = new Error('decompress failed')
        stubs.https = makeFakeHttps(stubs, { decompressErr })

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.equal('decompress failed')
        } finally {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        }
    })
})

describe("NodeService: getCryptoNode()", function () {

    it('verifies the downloaded bitcoin tarball before decompressing', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })

        // Hash verification ran for the right (repo, version, arch) BEFORE decompress.
        expect(stubs.gitHubDownloader.verifyFileHash.calledOnce).to.be.true
        const [, repoKey, version, arch] = stubs.gitHubDownloader.verifyFileHash.firstCall.args
        expect(repoKey).to.equal('bitcoin/bitcoin')
        expect(version).to.equal('v28.1')
        expect(arch).to.equal('x86_64')
        expect(stubs.gitHubDownloader.verifyFileHash.calledBefore(stubs.decompressTarGz)).to.be.true
    })

    it('rejects (and never decompresses) when the bitcoin tarball hash mismatches', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.gitHubDownloader.verifyFileHash.rejects(new Error('Hash verification failed for bitcoin/bitcoin@v28.1'))

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/Hash verification failed/)
            // Fail closed: the tampered tarball is never extracted, and the bad
            // file is cleaned up so a retry re-downloads.
            expect(stubs.decompressTarGz.called).to.be.false
            expect(stubs.fs.rmSync.called).to.be.true
        } finally {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        }
    })
})

describe("NodeService: getCryptoNode()", function () {

    it('rejects on a non-200 download response', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs, { statusCode: 404 })

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/HTTP 404/)
            expect(stubs.gitHubDownloader.verifyFileHash.called).to.be.false
            expect(stubs.decompressTarGz.called).to.be.false
        } finally {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        }
    })
    it('downloads dogecoin node via gitHubDownloader', async function () {
        const stubs = makeNodeServiceStubs()
        const ns = loadNodeService(stubs)
        const result = await ns.getCryptoNode('dogecoin', 'mainnet', 'v1.14.7')
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
        expect(result).to.be.true
    })

    it('downloads litecoin node via gitHubDownloader', async function () {
        const stubs = makeNodeServiceStubs()
        const ns = loadNodeService(stubs)
        const result = await ns.getCryptoNode('litecoin', 'mainnet', 'v0.21.3')
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
        expect(result).to.be.true
    })

    it('throws for an unsupported coin', async function () {
        const stubs = makeNodeServiceStubs()
        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('ethereum', 'mainnet', 'v1.0.0')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/no support for ethereum/)
        }
    })
})

describe("NodeService: getCryptoNode()", function () {

    it('strips leading "v" from bitcoin version string', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.fs.existsSync.returns(false)

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')

        // The writeFileSync version arg should NOT have a "v" prefix
        const versionArg = stubs.fs.writeFileSync.firstCall.args[1]
        expect(versionArg).to.equal('27.0')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
    })
})
