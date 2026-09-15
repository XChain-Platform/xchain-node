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

const { expect, makeNodeServiceStubs, loadNodeService, makeFakeHttps, makeFailoverHttps } = require('./support/helpers')

describe("NodeService: getCryptoNode()", function () {

    // One name, several mirrors, not equivalent: a leaf-only certificate chain
    // is fatal to Node where curl recovers via AIA, and a plain retry keeps
    // landing on the same address.
    describe("a broken mirror is not the whole install", function () {
        let origArch
        beforeEach(function () {
            origArch = process.arch
            Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
        })
        afterEach(function () {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        })
        it('retries on another mirror address after a TLS failure and succeeds', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFailoverHttps(stubs, { failures: 1 })
            stubs.dns = { promises: { lookup: async () => [{ address: '198.251.83.116', family: 4 }] } }
            stubs.fs.existsSync.returns(false)

            const ns = loadNodeService(stubs)
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')

            expect(stubs.https.get.callCount).to.equal(2)
            // The retry must pin the address while still requesting the same URL,
            // so the certificate is still checked against the hostname.
            const retryArgs = stubs.https.get.secondCall.args
            expect(retryArgs[0]).to.contain('https://bitcoincore.org/')
            expect(retryArgs[1]).to.have.property('lookup').that.is.a('function')
            // The download still has to clear the pinned hash before it is used.
            expect(stubs.gitHubDownloader.verifyFileHash.called).to.be.true
        })

        it('does not try other mirrors for an HTTP status, where every mirror agrees', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFakeHttps(stubs, { statusCode: 404 })
            stubs.dns = { promises: { lookup: async () => [{ address: '198.251.83.116', family: 4 }] } }

            const ns = loadNodeService(stubs)
            let threw = null
            try { await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1') } catch (err) { threw = err }

            expect(threw).to.be.an('error')
            expect(stubs.https.get.callCount).to.equal(1)
        })
    })
})

describe("NodeService: getCryptoNode()", function () {

    describe("a broken mirror is not the whole install", function () {
        let origArch
        beforeEach(function () {
            origArch = process.arch
            Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
        })
        afterEach(function () {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        })
        it('names the URL, the cause and a way forward when every mirror fails', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFailoverHttps(stubs, { failures: 99 })
            stubs.dns = { promises: { lookup: async () => [{ address: '194.204.0.12', family: 4 }] } }

            const ns = loadNodeService(stubs)
            let threw = null
            try { await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1') } catch (err) { threw = err }

            expect(threw).to.be.an('error')
            // The old message named neither the URL nor the cause, so a broken
            // mirror was indistinguishable from a broken installer.
            expect(threw.message).to.contain('bitcoincore.org')
            expect(threw.message).to.contain('unable to verify the first certificate')
            expect(threw.message).to.contain('curl')
            // The remediation names a path, so it has to name the path the
            // installer will actually read a placed tarball back from.
            expect(threw.message).to.contain('/crypto_nodes/bitcoin/bitcoin28.1.tar.gz')
            expect(stubs.gitHubDownloader.verifyFileHash.called).to.be.false
        })

        it('still makes one attempt when the name cannot be resolved at all', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFailoverHttps(stubs, { failures: 99 })
            stubs.dns = { promises: { lookup: async () => { throw new Error('EAI_AGAIN') } } }

            const ns = loadNodeService(stubs)
            let threw = null
            try { await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1') } catch (err) { threw = err }

            expect(threw).to.be.an('error')
            expect(stubs.https.get.callCount).to.equal(1)
        })
    })
})

describe("NodeService: getCryptoNode()", function () {

    describe("a broken mirror is not the whole install", function () {
        let origArch
        beforeEach(function () {
            origArch = process.arch
            Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
        })
        afterEach(function () {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        })
        // Asserting the lookup exists proves nothing: under autoSelectFamily
        // net.connect calls it with { all: true } and an answer in the
        // single-address form fails the connect before a socket is opened.
        it('answers the all:true form Node actually calls it with', async function () {
            const stubs = makeNodeServiceStubs()
            stubs.https = makeFailoverHttps(stubs, { failures: 1 })
            stubs.dns = { promises: { lookup: async () => [{ address: '198.251.83.116', family: 4 }] } }

            const ns = loadNodeService(stubs)
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v28.1')

            const { lookup } = stubs.https.get.secondCall.args[1]

            // What Node passes under autoSelectFamily: an array of records, or
            // the connect attempt throws before it dials.
            const all = await new Promise((resolve, reject) =>
                lookup('bitcoincore.org', { family: 0, hints: 32, all: true },
                    (err, res) => err ? reject(err) : resolve(res)))
            expect(all).to.be.an('array').with.lengthOf(1)
            expect(all[0]).to.include({ address: '198.251.83.116', family: 4 })

            // The legacy shape still has to work: options without `all` take the
            // (err, address, family) callback instead.
            const single = await new Promise((resolve, reject) =>
                lookup('bitcoincore.org', { family: 0 },
                    (err, address, family) => err ? reject(err) : resolve({ address, family })))
            expect(single).to.deep.equal({ address: '198.251.83.116', family: 4 })
        })
    })
})
