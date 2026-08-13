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

const { Coin, XChainService, EXPLORER_MODULE_NAME, NODE_VERSION_FILE_NAME, projectFolders } = require('../../src/config/constants')

function makeStubs() {
    return {
        fs: {
            existsSync: sinon.stub().returns(true),
            readFile: sinon.stub()
        },
        axiosGet: sinon.stub(),
        getDockerContainerFileData: sinon.stub(),
        // Defaults to failing so the pre-existing `docker cp` expectations below
        // still exercise the fallback path; tests of the preferred exec read
        // override it.
        getDockerContainerFileCat: sinon.stub().rejects(new Error('exec unavailable')),
        gitHubDownloader: {
            getLatestCompatibleVersion: sinon.stub()
        },
        remoteVersions: {},
        setRemoteModuleVersion: sinon.stub()
    }
}

function loadVersionService(stubs) {
    return proxyquire('../../src/services/VersionService', {
        'fs': stubs.fs,
        'axios': { get: stubs.axiosGet },
        '../config/constants': require('../../src/config/constants'),
        '../state': {
            gitHubDownloader: stubs.gitHubDownloader,
            getRemoteModuleVersions: () => stubs.remoteVersions,
            setRemoteModuleVersion: stubs.setRemoteModuleVersion
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            getCryptoNodeDir: (coin) => '/crypto_nodes/' + coin
        },
        './DockerService': {
            getDockerContainerFileData: stubs.getDockerContainerFileData,
            getDockerContainerFileCat: stubs.getDockerContainerFileCat
        }
    })
}

describe('VersionService', function () {

    describe('getGithubProjectVersion()', function () {

        it('calls GitHub API with correct URL', async function () {
            const stubs = makeStubs()
            stubs.axiosGet.resolves({ data: { tag_name: 'v1.2.3', id: 42 } })
            const vs = loadVersionService(stubs)
            await vs.getGithubProjectVersion('owner', 'repo')
            expect(stubs.axiosGet.firstCall.args[0]).to.equal(
                'https://api.github.com/repos/owner/repo/releases/latest'
            )
        })

        it('strips leading v from tag_name', async function () {
            const stubs = makeStubs()
            stubs.axiosGet.resolves({ data: { tag_name: 'v1.2.3', id: 42 } })
            const vs = loadVersionService(stubs)
            const result = await vs.getGithubProjectVersion('owner', 'repo')
            expect(result.version).to.equal('1.2.3')
        })

        it('preserves tag_name without v prefix', async function () {
            const stubs = makeStubs()
            stubs.axiosGet.resolves({ data: { tag_name: '1.2.3', id: 42 } })
            const vs = loadVersionService(stubs)
            const result = await vs.getGithubProjectVersion('owner', 'repo')
            expect(result.version).to.equal('1.2.3')
        })

        it('returns the release id', async function () {
            const stubs = makeStubs()
            stubs.axiosGet.resolves({ data: { tag_name: 'v1.0.0', id: 99 } })
            const vs = loadVersionService(stubs)
            const result = await vs.getGithubProjectVersion('owner', 'repo')
            expect(result.id).to.equal(99)
        })
    })

    describe('checkRemoteNodeVersion()', function () {

        it('calls gitHubDownloader for bitcoin with correct owner/repo', async function () {
            const stubs = makeStubs()
            stubs.gitHubDownloader.getLatestCompatibleVersion.resolves({ tag_name: 'v27.0' })
            const vs = loadVersionService(stubs)
            await vs.checkRemoteNodeVersion(Coin.BITCOIN)
            expect(stubs.gitHubDownloader.getLatestCompatibleVersion.calledWith('bitcoin', 'bitcoin', true)).to.be.true
        })

        it('calls gitHubDownloader for dogecoin with correct owner/repo', async function () {
            const stubs = makeStubs()
            stubs.gitHubDownloader.getLatestCompatibleVersion.resolves({ tag_name: 'v1.14.7' })
            const vs = loadVersionService(stubs)
            await vs.checkRemoteNodeVersion(Coin.DOGECOIN)
            expect(stubs.gitHubDownloader.getLatestCompatibleVersion.calledWith('dogecoin', 'dogecoin', true)).to.be.true
        })

        it('calls gitHubDownloader for litecoin with correct owner/repo', async function () {
            const stubs = makeStubs()
            stubs.gitHubDownloader.getLatestCompatibleVersion.resolves({ tag_name: 'v0.21.3' })
            const vs = loadVersionService(stubs)
            await vs.checkRemoteNodeVersion(Coin.LITECOIN)
            expect(stubs.gitHubDownloader.getLatestCompatibleVersion.calledWith('litecoin-project', 'litecoin', true)).to.be.true
        })

        it('stores result in remoteModuleVersions with node-<coin> key', async function () {
            const stubs = makeStubs()
            const release = { tag_name: 'v27.0' }
            stubs.gitHubDownloader.getLatestCompatibleVersion.resolves(release)
            const vs = loadVersionService(stubs)
            await vs.checkRemoteNodeVersion(Coin.BITCOIN)
            expect(stubs.setRemoteModuleVersion.calledWith('node-bitcoin', release)).to.be.true
        })
    })

    describe('getLocalNodeVersion()', function () {

        it('reads version from correct file path', async function () {
            const stubs = makeStubs()
            stubs.fs.readFile.callsFake((path, enc, cb) => {
                expect(path).to.include('/crypto_nodes/bitcoin/bitcoin/' + NODE_VERSION_FILE_NAME)
                cb(null, 'v27.0')
            })
            const vs = loadVersionService(stubs)
            const version = await vs.getLocalNodeVersion('bitcoin', 'mainnet')
            expect(version).to.equal('v27.0')
        })

        it('rejects when version file does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const vs = loadVersionService(stubs)
            try {
                await vs.getLocalNodeVersion('bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('No file')
            }
        })

        it('rejects on read error', async function () {
            const stubs = makeStubs()
            stubs.fs.readFile.callsFake((path, enc, cb) => cb(new Error('read error')))
            const vs = loadVersionService(stubs)
            try {
                await vs.getLocalNodeVersion('bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('problem reading')
            }
        })
    })

    describe('getLocalModuleVersion()', function () {

        it('reads version from module package.json', async function () {
            const stubs = makeStubs()
            stubs.fs.readFile.callsFake((path, enc, cb) => {
                expect(path).to.equal('/modules/xchain-encoder/package.json')
                cb(null, JSON.stringify({ version: '0.1.0' }))
            })
            const vs = loadVersionService(stubs)
            const version = await vs.getLocalModuleVersion('xchain-encoder')
            expect(version).to.equal('0.1.0')
        })

        it('rejects when package.json does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const vs = loadVersionService(stubs)
            try {
                await vs.getLocalModuleVersion('xchain-encoder')
                expect.fail()
            } catch (err) {
                expect(err).to.include('no file found')
            }
        })

        it('rejects when package.json has no version field', async function () {
            const stubs = makeStubs()
            stubs.fs.readFile.callsFake((path, enc, cb) => {
                cb(null, JSON.stringify({ name: 'xchain-encoder' }))
            })
            const vs = loadVersionService(stubs)
            try {
                await vs.getLocalModuleVersion('xchain-encoder')
                expect.fail()
            } catch (err) {
                expect(err).to.include("Couldn't find version")
            }
        })

        it('rejects when package.json is malformed', async function () {
            const stubs = makeStubs()
            stubs.fs.readFile.callsFake((path, enc, cb) => {
                cb(null, 'not-json')
            })
            const vs = loadVersionService(stubs)
            try {
                await vs.getLocalModuleVersion('xchain-encoder')
                expect.fail()
            } catch (err) {
                expect(err).to.include('problem parsing')
            }
        })
    })

    describe('getContainerNodeVersion()', function () {

        it('reads version file from container via docker cp', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileData.resolves('v27.0')
            const vs = loadVersionService(stubs)
            const version = await vs.getContainerNodeVersion('bitcoin', 'mainnet', 'container-123')
            expect(stubs.getDockerContainerFileData.calledWith('container-123', '/bitcoin/' + NODE_VERSION_FILE_NAME)).to.be.true
            expect(version).to.equal('v27.0')
        })

        it('throws on docker cp error', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileData.rejects(new Error('no such container'))
            const vs = loadVersionService(stubs)
            try {
                await vs.getContainerNodeVersion('bitcoin', 'mainnet', 'bad-id')
                expect.fail()
            } catch (err) {
                expect(err).to.include('error trying to get the version')
            }
        })
    })

    describe('getContainerModuleVersion()', function () {

        it('reads package.json from container and returns version', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileData.resolves(JSON.stringify({ version: '0.2.0' }))
            const vs = loadVersionService(stubs)
            const version = await vs.getContainerModuleVersion('xchain-encoder', 'bitcoin', 'mainnet', 'container-123')
            expect(stubs.getDockerContainerFileData.calledWith(
                'container-123',
                '/' + projectFolders['xchain-encoder'] + '/package.json'
            )).to.be.true
            expect(version).to.equal('0.2.0')
        })

        it('throws on docker cp error', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileData.rejects(new Error('no such container'))
            const vs = loadVersionService(stubs)
            try {
                await vs.getContainerModuleVersion('xchain-encoder', 'bitcoin', 'mainnet', 'bad-id')
                expect.fail()
            } catch (err) {
                expect(err).to.include('error trying to get package.json')
            }
        })

        // The live hub's `docker cp` fails on EVERY attempt with a daemon-side
        // "mkdirat ...: file exists", which made the hub version permanently
        // unreadable and turned every indexer update into a skew-guard refusal.
        // `docker exec cat` reads the same file with no host filesystem involved.
        it('reads the version with docker exec even when docker cp is permanently broken', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileCat.resolves(JSON.stringify({ version: '2.2.17' }))
            stubs.getDockerContainerFileData.rejects(
                new Error('Error response from daemon: mkdirat validator/capabilities.json: file exists')
            )
            const vs = loadVersionService(stubs)
            const version = await vs.getContainerModuleVersion('xchain-hub', '', '', 'hub-id')
            expect(version).to.equal('2.2.17')
            expect(stubs.getDockerContainerFileData.called).to.be.false
        })

        it('prefers the exec read over the host copy', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileCat.resolves(JSON.stringify({ version: '9.9.9' }))
            stubs.getDockerContainerFileData.resolves(JSON.stringify({ version: '0.0.1' }))
            const vs = loadVersionService(stubs)
            expect(await vs.getContainerModuleVersion('xchain-encoder', 'bitcoin', 'mainnet', 'c')).to.equal('9.9.9')
        })
    })

    describe('readContainerFile()', function () {

        // A stopped container cannot be exec'd into, but `ps` still wants its
        // version, so the host copy stays as the fallback.
        it('falls back to docker cp when the container cannot be exec\'d', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileCat.rejects(new Error('is not running'))
            stubs.getDockerContainerFileData.resolves('file-body')
            const vs = loadVersionService(stubs)
            expect(await vs.readContainerFile('c', '/a/b.json')).to.equal('file-body')
        })

        it('names BOTH failures when neither read works', async function () {
            const stubs = makeStubs()
            stubs.getDockerContainerFileCat.rejects(new Error('is not running'))
            stubs.getDockerContainerFileData.rejects(new Error('mkdirat: file exists'))
            const vs = loadVersionService(stubs)
            try {
                await vs.readContainerFile('c', '/a/b.json')
                expect.fail()
            } catch (err) {
                expect(err.message).to.match(/is not running/)
                expect(err.message).to.match(/mkdirat: file exists/)
            }
        })
    })

    describe('checkAllRemoteVersions()', function () {

        it('is a function that returns a promise', function () {
            const stubs = makeStubs()
            const vs = loadVersionService(stubs)
            expect(vs.checkAllRemoteVersions).to.be.a('function')
        })
    })
})
