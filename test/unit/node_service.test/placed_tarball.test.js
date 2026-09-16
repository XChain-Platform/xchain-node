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

const { expect, makeNodeServiceStubs, loadNodeService, makeFakeHttps, existingTarballFs } = require('./support/helpers')

describe("NodeService: getCryptoNode()", function () {

    // The failure message tells an operator to place the tarball and re-run,
    // the only escape when every resolved address serves the same broken
    // certificate chain. These hold that instruction to being true.
    describe("a tarball the operator placed by hand is used, not destroyed", function () {
        let origArch
        beforeEach(function () {
            origArch = process.arch
            Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
        })
        afterEach(function () {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        })
        it('skips the download entirely when the tarball is already at the path', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFakeHttps(stubs)
            existingTarballFs(stubs)

            const ns = loadNodeService(stubs)
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')

            expect(stubs.https.get.called).to.be.false
            expect(stubs.fs.createWriteStream.called).to.be.false
        })

        it('still verifies the placed tarball against the pinned hash before using it', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFakeHttps(stubs)
            existingTarballFs(stubs)

            const ns = loadNodeService(stubs)
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')

            // Once to decide the placed file is trustworthy at all, and once at
            // the gate every path goes through before decompression. The gate is
            // deliberately not conditional on how the bytes arrived.
            expect(stubs.gitHubDownloader.verifyFileHash.callCount).to.equal(2)
            expect(stubs.decompressTarGz.calledOnce).to.be.true
        })
    })
})

describe("NodeService: getCryptoNode()", function () {

    describe("a tarball the operator placed by hand is used, not destroyed", function () {
        let origArch
        beforeEach(function () {
            origArch = process.arch
            Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
        })
        afterEach(function () {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        })
        // Trusting a placed file must not cost the self-heal a half-written
        // leftover depends on: bytes that are not the pinned ones get discarded
        // and re-downloaded, never handed to the install.
        it('discards a file that fails the pinned hash and downloads instead', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFakeHttps(stubs)
            existingTarballFs(stubs)
            stubs.gitHubDownloader.verifyFileHash
                .onFirstCall().rejects(new Error('SHA-256 mismatch'))
                .onSecondCall().resolves()

            const ns = loadNodeService(stubs)
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')

            expect(stubs.fs.rmSync.called).to.be.true
            expect(stubs.https.get.calledOnce).to.be.true
            expect(stubs.decompressTarGz.calledOnce).to.be.true
        })

        it('never decompresses bytes that fail the pinned hash', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFakeHttps(stubs)
            existingTarballFs(stubs)
            stubs.gitHubDownloader.verifyFileHash.rejects(new Error('SHA-256 mismatch'))

            const ns = loadNodeService(stubs)
            let threw = null
            try { await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1') } catch (err) { threw = err }

            expect(threw).to.be.an('error')
            expect(stubs.decompressTarGz.called).to.be.false
        })
    })
})
