'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { Coin, Network, XChainService } = require('../../src/config/constants')

describe('utils/helpers', function () {

    // -------------------------------------------------------------------
    // stringToCoin
    // -------------------------------------------------------------------

    describe('stringToCoin()', function () {
        const { stringToCoin } = require('../../src/utils/helpers')

        it('returns BITCOIN key for "bitcoin"', function () {
            expect(stringToCoin('bitcoin')).to.equal('BITCOIN')
        })

        it('returns DOGECOIN key for "dogecoin"', function () {
            expect(stringToCoin('dogecoin')).to.equal('DOGECOIN')
        })

        it('returns LITECOIN key for "litecoin"', function () {
            expect(stringToCoin('litecoin')).to.equal('LITECOIN')
        })

        it('returns null for unknown coin', function () {
            expect(stringToCoin('ethereum')).to.be.null
        })

        it('returns null for empty string', function () {
            expect(stringToCoin('')).to.be.null
        })

        it('returns null for null', function () {
            expect(stringToCoin(null)).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // stringToXChainService
    // -------------------------------------------------------------------

    describe('stringToXChainService()', function () {
        const { stringToXChainService } = require('../../src/utils/helpers')

        it('returns XCHAIN_ENCODER for "xchain-encoder"', function () {
            expect(stringToXChainService('xchain-encoder')).to.equal('XCHAIN_ENCODER')
        })

        it('returns XCHAIN_DECODER for "xchain-decoder"', function () {
            expect(stringToXChainService('xchain-decoder')).to.equal('XCHAIN_DECODER')
        })

        it('returns XCHAIN_UTXO_TRACKER for "xchain-utxo-tracker"', function () {
            expect(stringToXChainService('xchain-utxo-tracker')).to.equal('XCHAIN_UTXO_TRACKER')
        })

        it('returns XCHAIN_INDEXER for "xchain-indexer"', function () {
            expect(stringToXChainService('xchain-indexer')).to.equal('XCHAIN_INDEXER')
        })

        it('returns XCHAIN_REGTEST_MINER for "xchain-regtest-miner"', function () {
            expect(stringToXChainService('xchain-regtest-miner')).to.equal('XCHAIN_REGTEST_MINER')
        })

        it('returns XCHAIN_E2E_TEST for "xchain-e2e-test"', function () {
            expect(stringToXChainService('xchain-e2e-test')).to.equal('XCHAIN_E2E_TEST')
        })

        it('returns null for unknown service', function () {
            expect(stringToXChainService('xchain-unknown')).to.be.null
        })

        it('returns null for empty string', function () {
            expect(stringToXChainService('')).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // stringToNetwork
    // -------------------------------------------------------------------

    describe('stringToNetwork()', function () {
        const { stringToNetwork } = require('../../src/utils/helpers')

        it('parses "bitcoin-mainnet" correctly', function () {
            const result = stringToNetwork('bitcoin-mainnet')
            expect(result.coin).to.equal('BITCOIN')
            expect(result.network).to.equal('MAINNET')
        })

        it('parses "dogecoin-testnet" correctly', function () {
            const result = stringToNetwork('dogecoin-testnet')
            expect(result.coin).to.equal('DOGECOIN')
            expect(result.network).to.equal('TESTNET')
        })

        it('parses "litecoin-regtest" correctly', function () {
            const result = stringToNetwork('litecoin-regtest')
            expect(result.coin).to.equal('LITECOIN')
            expect(result.network).to.equal('REGTEST')
        })

        it('returns null coin and network for unknown input', function () {
            const result = stringToNetwork('ethereum-goerli')
            expect(result.coin).to.be.null
            expect(result.network).to.be.null
        })

        it('handles single-segment string (no dash)', function () {
            const result = stringToNetwork('bitcoin')
            expect(result.coin).to.equal('BITCOIN')
            expect(result.network).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // sleep
    // -------------------------------------------------------------------

    describe('sleep()', function () {
        const { sleep } = require('../../src/utils/helpers')

        it('returns a promise that resolves', async function () {
            const result = await sleep(1)
            expect(result).to.be.undefined
        })

        it('resolves after the specified delay', async function () {
            const start = Date.now()
            await sleep(50)
            const elapsed = Date.now() - start
            expect(elapsed).to.be.at.least(40)
        })
    })

    // -------------------------------------------------------------------
    // decompressTarGz
    // -------------------------------------------------------------------

    describe('decompressTarGz()', function () {
        let execFileStub

        function loadHelpers(execFileImpl) {
            execFileStub = execFileImpl || sinon.stub()
            return proxyquire('../../src/utils/helpers', {
                'child_process': { execFile: execFileStub }
            })
        }

        /** Answers the member-listing call, then delegates the extract call */
        function listThenExtract(listing, extractImpl) {
            return function (cmd, args, opts, cb) {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (args[0] === '-tzf') return cb(null, listing)
                extractImpl(cmd, args, opts, cb)
            }
        }

        it('lists members first, then runs tar -xvzf with the file path', function (done) {
            const helpers = loadHelpers(listThenExtract('a/b.txt\n', function (cmd, args, opts, cb) {
                expect(cmd).to.equal('tar')
                expect(args).to.deep.equal(['-xvzf', '/tmp/archive.tar.gz'])
                cb(null)
            }))
            helpers.decompressTarGz('/tmp/archive.tar.gz').then(() => done()).catch(done)
        })

        it('sets cwd to the parent directory of the file on extraction', function (done) {
            const helpers = loadHelpers(listThenExtract('a/b.txt\n', function (cmd, args, opts, cb) {
                expect(opts.cwd).to.equal('/tmp')
                cb(null)
            }))
            helpers.decompressTarGz('/tmp/archive.tar.gz').then(() => done()).catch(done)
        })

        it('resolves true on success', async function () {
            const helpers = loadHelpers(listThenExtract('a/b.txt\n', function (cmd, args, opts, cb) {
                cb(null)
            }))
            const result = await helpers.decompressTarGz('/tmp/archive.tar.gz')
            expect(result).to.be.true
        })

        it('rejects with descriptive message on extraction error', async function () {
            const helpers = loadHelpers(listThenExtract('a/b.txt\n', function (cmd, args, opts, cb) {
                cb(new Error('tar failed'))
            }))
            try {
                await helpers.decompressTarGz('/tmp/archive.tar.gz')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.include('Error decompressing a file')
                expect(err).to.include('tar failed')
            }
        })

        it('rejects an absolute member path without extracting', async function () {
            let extracted = false
            const helpers = loadHelpers(listThenExtract('/etc/cron.d/evil\n', function (cmd, args, opts, cb) {
                extracted = true
                cb(null)
            }))
            try {
                await helpers.decompressTarGz('/tmp/archive.tar.gz')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('unsafe member path')
            }
            expect(extracted).to.be.false
        })

        it('rejects a ".." member path without extracting', async function () {
            let extracted = false
            const helpers = loadHelpers(listThenExtract('a/../../escape\n', function (cmd, args, opts, cb) {
                extracted = true
                cb(null)
            }))
            try {
                await helpers.decompressTarGz('/tmp/archive.tar.gz')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('unsafe member path')
            }
            expect(extracted).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // assertSafeArchiveMemberNames
    // -------------------------------------------------------------------

    describe('assertSafeArchiveMemberNames()', function () {
        const { assertSafeArchiveMemberNames } = require('../../src/utils/helpers')

        it('accepts relative member paths', function () {
            assertSafeArchiveMemberNames('a.txt\ndir/\ndir/b.txt\n', '/tmp/a.tgz')
        })

        it('accepts an empty listing', function () {
            assertSafeArchiveMemberNames('', '/tmp/a.tgz')
            assertSafeArchiveMemberNames(undefined, '/tmp/a.tgz')
        })

        it('accepts names merely containing dots ("a..b", "..hidden")', function () {
            assertSafeArchiveMemberNames('a..b\ndir/..hidden\nv1.2..3/\n', '/tmp/a.tgz')
        })

        it('throws on an absolute member path', function () {
            expect(() => assertSafeArchiveMemberNames('ok\n/etc/evil\n', '/tmp/a.tgz'))
                .to.throw(/unsafe member path "\/etc\/evil"/)
        })

        it('throws on a leading ".." segment', function () {
            expect(() => assertSafeArchiveMemberNames('../escape\n', '/tmp/a.tgz'))
                .to.throw(/unsafe member path/)
        })

        it('throws on an interior ".." segment', function () {
            expect(() => assertSafeArchiveMemberNames('dir/../../escape\n', '/tmp/a.tgz'))
                .to.throw(/unsafe member path/)
        })

        it('throws on a bare ".." member', function () {
            expect(() => assertSafeArchiveMemberNames('..\n', '/tmp/a.tgz'))
                .to.throw(/unsafe member path/)
        })
    })
})
