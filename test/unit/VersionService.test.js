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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        fs: {
            existsSync: sinon.stub().returns(true),
            readFile: sinon.stub()
        },
        axiosGet: sinon.stub(),
        getDockerContainerFileData: sinon.stub(),
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
            getDockerContainerFileData: stubs.getDockerContainerFileData
        }
    })
}

describe('VersionService', function () {

    // -------------------------------------------------------------------
    // getGithubProjectVersion
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // checkRemoteNodeVersion
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getLocalNodeVersion
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getLocalModuleVersion
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getContainerNodeVersion
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getContainerModuleVersion
    // -------------------------------------------------------------------

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
    })

    // -------------------------------------------------------------------
    // checkAllRemoteVersions
    // -------------------------------------------------------------------

    describe('checkAllRemoteVersions()', function () {

        it('is a function that returns a promise', function () {
            const stubs = makeStubs()
            const vs = loadVersionService(stubs)
            expect(vs.checkAllRemoteVersions).to.be.a('function')
        })
    })
})
