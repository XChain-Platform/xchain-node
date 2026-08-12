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
const path       = require('path')
const crypto     = require('crypto')

const validHash = 'a'.repeat(64)
const validHashesData = {
    'owner/repo': { 'v1.0.0': validHash }
}

function makeAxiosStub() {
    return {
        get: sinon.stub(),
        post: sinon.stub()
    }
}

function loadDownloader(opts = {}) {
    const fsStub = opts.fs || {
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().returns(JSON.stringify(validHashesData)),
        writeFileSync: sinon.stub(),
        createWriteStream: sinon.stub(),
        mkdirSync: sinon.stub(),
        rmSync: sinon.stub(),
        readdirSync: sinon.stub().returns([]),
        statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
        readFileSync: sinon.stub().callsFake((p, enc) => {
            if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                return JSON.stringify(validHashesData)
            }
            return Buffer.from('file-content')
        })
    }
    const axiosStub = opts.axios || makeAxiosStub()
    const spawnSyncStub = opts.spawnSync || sinon.stub().returns({ status: 0 })

    const GitHubDownloader = proxyquire('../../src/GitHubDownloader', {
        'fs': fsStub,
        'axios': axiosStub,
        'child_process': { spawnSync: spawnSyncStub }
    })

    return { GitHubDownloader, fsStub, axiosStub, spawnSyncStub }
}

describe('GitHubDownloader', function () {

    describe('constructor', function () {

        it('loads hashes file on construction', function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl.hashesData).to.deep.equal(validHashesData)
        })

        it('creates empty hashes file if it does not exist', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                writeFileSync: sinon.stub(),
                readFileSync: sinon.stub().returns('{}'),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(fsStub.writeFileSync.calledOnce).to.be.true
        })

        it('throws on invalid hash format (non-64 char hex)', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    'owner/repo': { 'v1.0.0': 'short-hash' }
                })),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid SHA-256 hash')
        })
    })

    describe('hasHash()', function () {

        it('returns true when hash exists for repo/version', function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl.hasHash('owner/repo', 'v1.0.0')).to.be.true
        })

        it('returns false when hash does not exist', function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl.hasHash('owner/repo', 'v2.0.0')).to.be.false
        })

        it('returns false for unknown repo', function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl.hasHash('unknown/repo', 'v1.0.0')).to.be.false
        })
    })

    describe('getReleases()', function () {

        it('calls GitHub API with correct URL', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({ data: [] })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            await dl.getReleases('bitcoin', 'bitcoin')
            const url = axiosStub.get.firstCall.args[0]
            expect(url).to.equal('https://api.github.com/repos/bitcoin/bitcoin/releases')
        })

        it('returns release data on success', async function () {
            const axiosStub = makeAxiosStub()
            const releases = [{ tag_name: 'v1.0.0' }]
            axiosStub.get.resolves({ data: releases })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            const result = await dl.getReleases('bitcoin', 'bitcoin')
            expect(result).to.deep.equal(releases)
        })

        it('throws with descriptive message on 404', async function () {
            const axiosStub = makeAxiosStub()
            const err = new Error('Not Found')
            err.response = { status: 404 }
            axiosStub.get.rejects(err)
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.getReleases('bad', 'repo')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include("Can't find")
            }
        })

        it('sends no Authorization header without a token', async function () {
            delete process.env.GITHUB_TOKEN
            delete process.env.GH_TOKEN
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({ data: [] })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            await dl.getReleases('bitcoin', 'bitcoin')
            expect(axiosStub.get.firstCall.args[1].headers).to.not.have.property('Authorization')
        })

        it('sends Authorization: Bearer when GITHUB_TOKEN is set', async function () {
            process.env.GITHUB_TOKEN = 'test-token-value'
            try {
                const axiosStub = makeAxiosStub()
                axiosStub.get.resolves({ data: [] })
                const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
                const dl = new GitHubDownloader('/test/hashes.json')
                await dl.getReleases('bitcoin', 'bitcoin')
                expect(axiosStub.get.firstCall.args[1].headers.Authorization).to.equal('Bearer test-token-value')
            } finally {
                delete process.env.GITHUB_TOKEN
            }
        })

        it('surfaces a rate-limit-specific error on 403 with remaining=0', async function () {
            const axiosStub = makeAxiosStub()
            const err = new Error('Request failed with status code 403')
            err.response = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1783529945' } }
            axiosStub.get.rejects(err)
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.getReleases('bitcoin', 'bitcoin')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('rate limit exhausted')
                expect(e.message).to.include('GITHUB_TOKEN')
                expect(e.message).to.include('2026-07-08T16:59:05')
            }
        })

        it('a plain 403 (not rate-limited) keeps the generic API error', async function () {
            const axiosStub = makeAxiosStub()
            const err = new Error('Request failed with status code 403')
            err.response = { status: 403, headers: { 'x-ratelimit-remaining': '42' } }
            axiosStub.get.rejects(err)
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.getReleases('bitcoin', 'bitcoin')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('GitHub API Error')
            }
        })
    })

    describe('getLatestCompatibleVersion()', function () {

        it('returns the latest release with a matching hash when verifyHash=true', async function () {
            const axiosStub = makeAxiosStub()
            const releases = [
                { tag_name: 'v2.0.0', published_at: '2025-01-02T00:00:00Z' },
                { tag_name: 'v1.0.0', published_at: '2025-01-01T00:00:00Z' }
            ]
            axiosStub.get.resolves({ data: releases })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            // Only v1.0.0 has a hash in validHashesData (under owner/repo)
            const result = await dl.getLatestCompatibleVersion('owner', 'repo', true)
            expect(result.tag_name).to.equal('v1.0.0')
        })

        it('returns the latest release regardless of hash when verifyHash=false', async function () {
            const axiosStub = makeAxiosStub()
            const releases = [
                { tag_name: 'v2.0.0', published_at: '2025-01-02T00:00:00Z' },
                { tag_name: 'v1.0.0', published_at: '2025-01-01T00:00:00Z' }
            ]
            axiosStub.get.resolves({ data: releases })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            const result = await dl.getLatestCompatibleVersion('owner', 'repo', false)
            expect(result.tag_name).to.equal('v2.0.0')
        })

        it('throws when no version has a matching hash', async function () {
            const axiosStub = makeAxiosStub()
            const releases = [
                { tag_name: 'v3.0.0', published_at: '2025-01-03T00:00:00Z' }
            ]
            axiosStub.get.resolves({ data: releases })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.getLatestCompatibleVersion('owner', 'repo', true)
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('hashes file')
            }
        })
    })

    describe('getReleaseByTag()', function () {

        it('calls correct GitHub API URL with tag', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({ data: { tag_name: 'v1.0.0' } })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            await dl.getReleaseByTag('bitcoin', 'bitcoin', 'v27.0')
            const url = axiosStub.get.firstCall.args[0]
            expect(url).to.equal('https://api.github.com/repos/bitcoin/bitcoin/releases/tags/v27.0')
        })
    })

    describe('getAllFiles()', function () {

        it('returns single file in array when path is a file', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify(validHashesData)),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            const files = dl.getAllFiles('/path/to/file.txt')
            expect(files).to.deep.equal(['/path/to/file.txt'])
        })

        it('returns empty array on error', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify(validHashesData)),
                statSync: sinon.stub().callsFake((p) => {
                    if (p === '/test/hashes.json' || p.endsWith('github_hashes.json')) {
                        return { isFile: () => true, isDirectory: () => false }
                    }
                    throw new Error('not found')
                }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            const files = dl.getAllFiles('/nonexistent')
            expect(files).to.deep.equal([])
        })
    })

    describe('calculateDirectoryHash()', function () {

        it('computes SHA-256 hash from file contents', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p, enc) => {
                    if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                        return JSON.stringify(validHashesData)
                    }
                    return Buffer.from('test-content')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            const hash = await dl.calculateDirectoryHash('/path/to/file')
            // The hash should be SHA-256 of 'test-content'
            const expected = crypto.createHash('sha256').update(Buffer.from('test-content')).digest('hex')
            expect(hash).to.equal(expected)
        })
    })

    describe('verifyFileHash()', function () {

        const contentHash = crypto.createHash('sha256').update(Buffer.from('tarball-bytes')).digest('hex')

        function makeFsWith(hashesData) {
            return {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (typeof p === 'string' && p.endsWith('hashes.json')) return JSON.stringify(hashesData)
                    return Buffer.from('tarball-bytes')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
        }

        it('computes the SHA-256 of the file bytes', async function () {
            const { GitHubDownloader } = loadDownloader({ fs: makeFsWith(validHashesData) })
            const dl = new GitHubDownloader('/test/hashes.json')
            const hash = await dl.calculateFileHash('/tmp/bitcoin.tar.gz')
            expect(hash).to.equal(contentHash)
        })

        it('passes when the tarball hash matches the registered per-arch hash', async function () {
            const data = { 'bitcoin/bitcoin': { 'v28.1': { x86_64: contentHash, aarch64: 'd'.repeat(64) } } }
            const { GitHubDownloader } = loadDownloader({ fs: makeFsWith(data) })
            const dl = new GitHubDownloader('/test/hashes.json')
            // Resolves without throwing.
            await dl.verifyFileHash('/tmp/bitcoin.tar.gz', 'bitcoin/bitcoin', 'v28.1', 'x86_64')
        })

        it('throws when the tarball hash does not match', async function () {
            const data = { 'bitcoin/bitcoin': { 'v28.1': { x86_64: 'e'.repeat(64) } } }
            const { GitHubDownloader } = loadDownloader({ fs: makeFsWith(data) })
            const dl = new GitHubDownloader('/test/hashes.json')
            let threw = false
            try {
                await dl.verifyFileHash('/tmp/bitcoin.tar.gz', 'bitcoin/bitcoin', 'v28.1', 'x86_64')
            } catch (err) {
                threw = true
                expect(err.message).to.match(/Hash verification failed/)
            }
            expect(threw, 'verifyFileHash should reject on mismatch').to.be.true
        })

        it('fails closed when no hash is registered for the version/arch', async function () {
            const { GitHubDownloader } = loadDownloader({ fs: makeFsWith({}) })
            const dl = new GitHubDownloader('/test/hashes.json')
            let threw = false
            try {
                await dl.verifyFileHash('/tmp/bitcoin.tar.gz', 'bitcoin/bitcoin', 'v99.9', 'x86_64')
            } catch (err) {
                threw = true
                expect(err.message).to.match(/No SHA-256 hash registered/)
            }
            expect(threw, 'verifyFileHash should reject when unregistered').to.be.true
        })
    })

    describe('_getHashForArch()', function () {

        it('returns string hash for legacy string entry (any arch)', function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            // validHashesData has 'owner/repo': { 'v1.0.0': validHash } (string)
            const result = dl._getHashForArch('owner/repo', 'v1.0.0', 'x86_64')
            expect(result).to.equal(validHash)
        })

        it('returns arch-specific hash for object entry', function () {
            const xHash = 'b'.repeat(64)
            const armHash = 'c'.repeat(64)
            const customData = { 'owner/repo': { 'v2.0.0': { x86_64: xHash, aarch64: armHash } } }
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(customData)
                    return Buffer.from('data')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl._getHashForArch('owner/repo', 'v2.0.0', 'x86_64')).to.equal(xHash)
            expect(dl._getHashForArch('owner/repo', 'v2.0.0', 'aarch64')).to.equal(armHash)
        })

        it('returns null for unknown arch in object entry', function () {
            const xHash = 'b'.repeat(64)
            const customData = { 'owner/repo': { 'v2.0.0': { x86_64: xHash } } }
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(customData)
                    return Buffer.from('data')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl._getHashForArch('owner/repo', 'v2.0.0', 'unknown_arch')).to.be.null
        })

        it('returns null for missing repo/version', function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl._getHashForArch('nobody/norepo', 'v0.0.0', 'x86_64')).to.be.null
        })
    })

    describe('hasHash(): arch-specific', function () {

        it('returns true for object entry with matching arch', function () {
            const xHash = 'b'.repeat(64)
            const customData = { 'owner/repo': { 'v2.0.0': { x86_64: xHash } } }
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(customData)
                    return Buffer.from('data')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl.hasHash('owner/repo', 'v2.0.0', 'x86_64')).to.be.true
            expect(dl.hasHash('owner/repo', 'v2.0.0', 'aarch64')).to.be.false
        })

        it('returns true for object entry with no arch requirement when keys exist', function () {
            const xHash = 'b'.repeat(64)
            const customData = { 'owner/repo': { 'v2.0.0': { x86_64: xHash } } }
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(customData)
                    return Buffer.from('data')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            expect(dl.hasHash('owner/repo', 'v2.0.0')).to.be.true // no arch → any hash counts
        })
    })

    describe('getReleases(): generic error', function () {

        it('throws with generic error message on non-404 errors', async function () {
            const axiosStub = makeAxiosStub()
            const err = new Error('Network Error')
            axiosStub.get.rejects(err)
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.getReleases('owner', 'repo')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('GitHub API Error')
            }
        })
    })

    describe('getReleaseByTag(): error', function () {

        it('throws with descriptive message on error', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.rejects(new Error('Not Found'))
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.getReleaseByTag('owner', 'repo', 'v1.0.0')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('Error getting the release')
            }
        })
    })

    describe('downloadRepoVersion()', function () {

        it('throws when hash not found for repo/version', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({ data: { tag_name: 'v99.0.0', assets: [] } })
            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.downloadRepoVersion('owner', 'repo', 'v99.0.0', { verifyHash: true })
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('Required SHA-256 hash not found')
            }
        })

        it('cleans up output directory when download fails', async function () {
            const axiosStub = makeAxiosStub()
            // getReleaseByTag returns a release, but downloadReleaseAsset will fail (no matching asset)
            axiosStub.get.resolves({
                data: {
                    tag_name: 'v1.0.0',
                    assets: [] // no assets → downloadReleaseAsset throws
                }
            })
            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => {
                    // hashes file exists
                    if (p.endsWith('hashes.json')) return true
                    // output path exists (to trigger cleanup)
                    return true
                }),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub(),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            try {
                await dl.downloadRepoVersion('owner', 'repo', 'v1.0.0', { verifyHash: false })
                expect.fail()
            } catch (e) {
                expect(fsStub.rmSync.called).to.be.true
            }
        })

        it('writes version file on successful download', async function () {
            // Use a custom downloader where downloadReleaseAsset is stubbed
            const axiosStub = makeAxiosStub()
            const releaseData = { tag_name: 'v1.0.0', assets: [] }
            axiosStub.get.resolves({ data: releaseData })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return true
                    return true // output path exists → triggers version file write
                }),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub(),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            // Stub downloadReleaseAsset to succeed without real download
            dl.downloadReleaseAsset = sinon.stub().resolves()
            const result = await dl.downloadRepoVersion('owner', 'repo', 'v1.0.0', { verifyHash: false })
            expect(fsStub.writeFileSync.called).to.be.true
            expect(result).to.include('repo')
        })
    })

    describe('downloadReleaseAsset()', function () {

        it('throws when no matching linux asset found for host arch', async function () {
            // Build a release with only a Windows asset so asset selection fails
            const { Readable } = require('stream')
            const axiosFn = sinon.stub().resolves({ data: new Readable({ read() {} }) })
            axiosFn.get = sinon.stub()
            const { GitHubDownloader } = loadDownloader({ axios: axiosFn })
            const dl = new GitHubDownloader('/test/hashes.json')

            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    // Windows-only asset; no linux match
                    { name: `bitcoin-win64-${arch}.zip`, browser_download_url: 'http://example.com/win.zip' }
                ]
            }
            try {
                await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
                expect.fail()
            } catch (e) {
                // downloadReleaseAsset wraps in "Error downloading asset: <inner message>"
                expect(e.message).to.satisfy((m) =>
                    m.includes('linux') || m.includes('Error downloading asset')
                )
            }
        })

        it('downloads gz asset using axios stream + pipeline, extracts with tar', async function () {
            // Use a proper Writable stream to satisfy pipeline's dst.end requirement
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null)) // end stream async

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()

            const spawnSyncStub = sinon.stub().returns({ status: 0 })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            // Create a proper Writable for createWriteStream
            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return true
                    return false // output path doesn't exist → mkdirSync
                }),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('binary data')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]), // no extracted dirs
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
                ]
            }

            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect(spawnSyncStub.calledWith('tar')).to.be.true
            expect(fsStub.unlinkSync.calledOnce).to.be.true
        })

        it('refuses to extract a gz asset with an unsafe member path', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()

            // Member listing (tar -tzf) reports an absolute path; extraction must not run
            const spawnSyncStub = sinon.stub().callsFake((cmd, args) => {
                if (args[0] === '-tzf') return { status: 0, stdout: 'ok.txt\n/etc/cron.d/evil\n' }
                return { status: 0 }
            })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('binary data')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
                ]
            }

            try {
                await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include('unsafe member path')
            }
            expect(spawnSyncStub.calledWith('tar', sinon.match(args => args[0] === '-xzf'))).to.be.false
            expect(fsStub.unlinkSync.called).to.be.false
        })

        it('extracts zip asset and calls unzip', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()

            const spawnSyncStub = sinon.stub().returns({ status: 0 })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('zip content')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.zip`, browser_download_url: 'http://example.com/bitcoin.zip' }
                ]
            }

            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect(spawnSyncStub.calledWith('unzip')).to.be.true
            expect(fsStub.unlinkSync.calledOnce).to.be.true
        })

        it('refuses to extract a zip asset with an unsafe member path', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()

            // Member listing (unzip -Z1) reports a traversal path; the extraction
            // pass (bare `unzip -d`) must not run, mirroring the tar branch.
            const spawnSyncStub = sinon.stub().callsFake((cmd, args) => {
                if (args[0] === '-Z1') return { status: 0, stdout: 'ok.txt\n../../etc/evil\n' }
                return { status: 0 }
            })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('zip content')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.zip`, browser_download_url: 'http://example.com/bitcoin.zip' }
                ]
            }

            try {
                await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include('unsafe member path')
            }
            // The extraction pass is `unzip <file> -d <out>`; assert it never ran.
            expect(spawnSyncStub.calledWith('unzip', sinon.match(args => args[1] === '-d'))).to.be.false
            expect(fsStub.unlinkSync.called).to.be.false
        })

        it('handles single extracted directory by flattening contents', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()
            const spawnSyncStub = sinon.stub().returns({ status: 0 })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })
            const renameSync = sinon.stub()
            const rmdirSync = sinon.stub()

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return { isFile: () => true, isDirectory: () => false }
                    if (p.includes('extracted-dir')) return { isFile: () => false, isDirectory: () => true }
                    return { isFile: () => true, isDirectory: () => false }
                }),
                readdirSync: sinon.stub().callsFake((p) => {
                    if (p === '/output') return ['extracted-dir'] // one extracted dir
                    return ['file1.txt', 'bin'] // files inside the extracted dir
                }),
                renameSync,
                rmdirSync,
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
                ]
            }

            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            // Single extracted dir → rename + rmdirSync
            expect(renameSync.called).to.be.true
            expect(rmdirSync.calledOnce).to.be.true
        })

        it('warns on unrecognized file extension (no extraction)', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()
            const spawnSyncStub = sinon.stub().returns({ status: 0 })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    // .bin extension → unrecognized → warn, no extract
                    { name: `bitcoin-linux-${arch}.bin`, browser_download_url: 'http://example.com/bitcoin.bin' }
                ]
            }

            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect(spawnSyncStub.called).to.be.false
        })

        it('throws when unzip fails with non-zero exit code', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()
            // The safe-member listing pass (`-Z1`) succeeds; the extraction pass
            // (`unzip <file> -d <out>`) is what fails with a non-zero exit.
            const spawnSyncStub = sinon.stub().callsFake((cmd, args) => {
                if (args[0] === '-Z1') return { status: 0, stdout: 'ok.txt\n' }
                return { status: 2 } // unzip extraction fails
            })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.zip`, browser_download_url: 'http://example.com/bitcoin.zip' }
                ]
            }

            try {
                await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('Error downloading asset')
                expect(e.message).to.include('unzip exited with code')
            }
        })

        it('throws when tar fails with non-zero exit code', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()
            const spawnSyncStub = sinon.stub().returns({ status: 1 }) // tar fails
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            dl.verifyRepositoryHash = sinon.stub().resolves()

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
                ]
            }

            try {
                await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('Error downloading asset')
                expect(e.message).to.include('tar exited with code')
            }
        })
    })

    describe('getAllFiles(): directory traversal', function () {

        it('returns all files recursively from a directory', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('content')
                }),
                statSync: sinon.stub().callsFake((p) => {
                    if (p === '/test/hashes.json') return { isFile: () => true, isDirectory: () => false }
                    if (p === '/dir' || p === '/dir/subdir') return { isFile: () => false, isDirectory: () => true }
                    return { isFile: () => true, isDirectory: () => false }
                }),
                readdirSync: sinon.stub().callsFake((p, opts) => {
                    if (p === '/dir') {
                        return [
                            { name: 'file.txt', isDirectory: () => false, isFile: () => true },
                            { name: 'subdir', isDirectory: () => true, isFile: () => false }
                        ]
                    }
                    if (p === '/dir/subdir') {
                        return [
                            { name: 'nested.txt', isDirectory: () => false, isFile: () => true }
                        ]
                    }
                    return []
                })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            const files = dl.getAllFiles('/dir')
            expect(files).to.include('/dir/file.txt')
            expect(files).to.include('/dir/subdir/nested.txt')
        })
    })

    describe('loadHashesFile(): invalid hash in object entry', function () {

        it('throws when arch hash is invalid in object entry', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    'owner/repo': { 'v1.0.0': { x86_64: 'short' } }
                })),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid SHA-256 hash')
        })

        it('throws when version entry is neither string nor object', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    'owner/repo': { 'v1.0.0': null }
                })),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid hash entry')
        })

        it('throws when top-level repo entry is not an object', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    'owner/repo': 'not-an-object'
                })),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid hash format')
        })
    })

    describe('downloadReleaseAsset(): verifyHash=true', function () {

        it('calls verifyRepositoryHash when verifyHash=true', async function () {
            const { Readable, Writable } = require('stream')
            const responseStream = new Readable({ read() {} })
            setImmediate(() => responseStream.push(null))

            const axiosFn = sinon.stub().resolves({ data: responseStream })
            axiosFn.get = sinon.stub()
            const spawnSyncStub = sinon.stub().returns({ status: 0 })
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

            const ws = new Writable({ write(chunk, enc, cb) { cb() } })

            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                    return Buffer.from('data')
                }),
                writeFileSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createWriteStream: sinon.stub().returns(ws),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([]),
                unlinkSync: sinon.stub()
            }

            const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            const verifyStub = sinon.stub().resolves()
            dl.verifyRepositoryHash = verifyStub

            const release = {
                tag_name: 'v1.0.0',
                assets: [
                    { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
                ]
            }

            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', true) // verifyHash=true
            expect(verifyStub.calledOnce).to.be.true
        })
    })

    describe('verifyRepositoryHash()', function () {

        it('does not throw when hash matches', async function () {
            // We need a predictable hash
            const content = Buffer.from('test')
            const expectedHash = crypto.createHash('sha256').update(content).digest('hex')

            const customHashesData = { 'owner/repo': { 'v1.0.0': expectedHash } }
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                        return JSON.stringify(customHashesData)
                    }
                    return content
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            // Should not throw
            await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/file')
        })

        it('throws when hash does not match', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                        return JSON.stringify(validHashesData)
                    }
                    return Buffer.from('different-content')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            try {
                await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/file')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('Hash verification failed')
            }
        })

        it('throws when no hash registered for the repo/version/arch', async function () {
            const { GitHubDownloader } = loadDownloader()
            const dl = new GitHubDownloader('/test/hashes.json')
            // 'unknown/repo' has no entry in validHashesData
            try {
                await dl.verifyRepositoryHash('unknown/repo', 'v1.0.0', '/path/to/file')
                expect.fail()
            } catch (e) {
                expect(e.message).to.include('No SHA-256 hash registered')
            }
        })

        it('passes explicit arch parameter to _getHashForArch', async function () {
            const content = Buffer.from('test')
            const expectedHash = crypto.createHash('sha256').update(content).digest('hex')

            const customHashesData = { 'owner/repo': { 'v1.0.0': { myarch: expectedHash } } }
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('hashes.json')) return JSON.stringify(customHashesData)
                    return content
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')
            // Should not throw when passing the right arch
            await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/file', 'myarch')
        })
    })
})
