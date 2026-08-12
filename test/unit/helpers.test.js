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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { Coin, Network, XChainService } = require('../../src/config/constants')

describe('utils/helpers', function () {

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

    describe('sleep()', function () {
        const { sleep } = require('../../src/utils/helpers')

        it('returns a promise that resolves', async function () {
            const result = await sleep(1)
            expect(result).to.be.undefined
        })

        // Drives the delay on a fake clock; a wall-clock elapsed assertion flakes under CI jitter.
        it('resolves after the specified delay', async function () {
            const clock = sinon.useFakeTimers()
            try {
                let resolved = false
                const pending = sleep(50).then(() => { resolved = true })
                await clock.tickAsync(49)
                expect(resolved).to.equal(false)
                await clock.tickAsync(1)
                await pending
                expect(resolved).to.equal(true)
            } finally {
                clock.restore()
            }
        })
    })

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

    describe('redactSecrets()', function () {
        const { redactSecrets } = require('../../src/utils/helpers')

        it("masks the value inside PASSWORD('…')", function () {
            const out = redactSecrets("CREATE USER 'x'@'%' IDENTIFIED BY PASSWORD('s3cr3t-pw')")
            expect(out).to.not.include('s3cr3t-pw')
            expect(out).to.include("PASSWORD('<redacted>')")
        })

        it("masks IDENTIFIED BY '…' literals", function () {
            const out = redactSecrets("CREATE USER 'x'@'%' IDENTIFIED BY 'pla1n-pw'")
            expect(out).to.not.include('pla1n-pw')
            expect(out).to.include("IDENTIFIED BY '<redacted>'")
        })

        it('masks MYSQL_PWD / MYSQL_ROOT_PASSWORD env values', function () {
            const out = redactSecrets('docker exec -e MYSQL_PWD=topsecret ... MYSQL_ROOT_PASSWORD=rootsecret')
            expect(out).to.not.include('topsecret')
            expect(out).to.not.include('rootsecret')
            expect(out).to.include('MYSQL_PWD=<redacted>')
        })

        it('accepts an Error and redacts secrets from its stack', function () {
            const out = redactSecrets(new Error("failed near PASSWORD('leak-me')"))
            expect(out).to.not.include('leak-me')
            expect(out).to.include("PASSWORD('<redacted>')")
        })

        it('masks the per-install service secrets in a failed docker-run argv', function () {
            const out = redactSecrets(
                'Command failed: docker run -e HUB_DB_PASS=9f3caabb -e NODE_PASSWORD=sekret ' +
                '-e HUB_API_KEY=abc123 -e INDEXER_API_KEY=k -e BTC_ENCODER_API_KEY=k2 ' +
                '-e TELEMETRY_ADMIN_KEY=k3 -e DECODER_PORT=8080 -t img'
            )
            for (const secret of ['9f3caabb', 'sekret', 'abc123', 'k2', 'k3']) {
                expect(out).to.not.include(secret)
            }
            expect(out).to.include('HUB_DB_PASS=<redacted>')
            expect(out).to.include('HUB_API_KEY=<redacted>')
            // A non-secret env value (a port) is left intact.
            expect(out).to.include('DECODER_PORT=8080')
        })

        it('masks credentials embedded in a git/remote URL', function () {
            const out = redactSecrets(
                'Error cloning project: Command failed: git clone ' +
                'https://x-access-token:ghp_REALTOKEN@github.com/acme/x.git /dst'
            )
            expect(out).to.not.include('ghp_REALTOKEN')
            expect(out).to.not.include('x-access-token')
            expect(out).to.include('https://<redacted>@github.com/acme/x.git')
        })

        it('returns clean strings unchanged and handles null', function () {
            expect(redactSecrets('nothing secret here')).to.equal('nothing secret here')
            expect(redactSecrets(null)).to.equal('')
        })
    })
})
