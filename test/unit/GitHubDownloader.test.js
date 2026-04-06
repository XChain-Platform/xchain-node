'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const crypto     = require('crypto')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // Constructor & loadHashesFile
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // hasHash
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getReleases
    // -------------------------------------------------------------------

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
    })

    // -------------------------------------------------------------------
    // getLatestCompatibleVersion
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getReleaseByTag
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getAllFiles
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // calculateDirectoryHash
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // verifyRepositoryHash
    // -------------------------------------------------------------------

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
    })
})
