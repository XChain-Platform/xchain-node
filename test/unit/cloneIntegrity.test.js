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
//
// Clone integrity and bundled-library pinning (release-management spec
// sections 8 and 11). These cover the round's critical finding: bundled
// libraries were cloned at the remote's DEFAULT BRANCH tip, so the one
// consensus-critical component staged into the indexer and explorer images
// was the one part of a "pinned" install that floated.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const fsReal     = require('fs')
const pathReal   = require('path')

const PIN_SHA   = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

// Build ModuleService with git fully faked: `git clone` through the callback
// execFile, and `git rev-parse` through the promisified one.
function loadWithGit({ revParse, cloneFails = false } = {}) {
    const execFileStub = sinon.stub().callsFake((cmd, args, cb) => {
        if (cloneFails) return cb(new Error('clone exploded'), '', 'fatal: boom')
        return cb(null, '', '')
    })

    const fs = {
        existsSync:   sinon.stub().returns(true),
        rmSync:       sinon.stub(),
        mkdirSync:    sinon.stub(),
        readFileSync: sinon.stub(),
        cpSync:       sinon.stub(),
        renameSync:   sinon.stub()
    }

    const configService = {
        getModuleDir:      (mod) => '/modules/' + mod,
        getModuleTmpDir:   (mod) => '/tmp/' + mod,
        moduleDirExists:   sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir:   sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: sinon.stub().returns('img'),
        getDockerNetwork:  sinon.stub().returns('net'),
        getUtxoTrackerVolumeName: sinon.stub().returns('vol'),
        validatePort:      () => true,
        getDefaultConfig:  sinon.stub().resolves({})
    }

    const ms = proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: execFileStub },
        'util': { promisify: () => async (...args) => revParse(...args) },
        'fs': fs,
        '../state': {
            db: {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer:    sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': configService,
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': {
            killContainer: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            forceRemoveContainerByName: sinon.stub().resolves(true),
            getPublishedHostPorts: sinon.stub().resolves(new Map())
        },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
        './VersionService': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
        './NodeService': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
        './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
    })

    return { ms, execFileStub, fs, configService }
}

// The real service, used for its active-target state in the pinning tests.
const releaseSvc = require('../../src/services/ReleaseManifestService')

function pinnedTarget(components) {
    return { kind: 'release', tag: 'v0.9.0', manifest: { platform_version: '0.9.0', components } }
}

describe('clone integrity (manifest-pinned installs)', () => {

    afterEach(() => {
        releaseSvc.clearActiveTarget()
        sinon.restore()
    })

    describe('cloneGit() commit verification', () => {

        it('accepts a clone whose HEAD matches the pinned commit', async () => {
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: PIN_SHA + '\n' }) })
            const ok = await ms.cloneGit('xchain-vm', false, false, 'v0.9.0', PIN_SHA)
            expect(ok).to.equal(true)
        })

        it('REFUSES a clone whose HEAD differs from the pinned commit', async () => {
            // This is the moved-tag case: `-b v0.9.0` succeeded, but the tag no
            // longer points at the reviewed commit.
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: OTHER_SHA + '\n' }) })
            await ms.cloneGit('xchain-vm', false, false, 'v0.9.0', PIN_SHA).then(
                () => { throw new Error('should have refused') },
                e => {
                    expect(e.message).to.match(/Clone integrity check FAILED for 'xchain-vm'/)
                    expect(e.message).to.include(PIN_SHA)
                    expect(e.message).to.include(OTHER_SHA)
                    expect(e.message).to.match(/Nothing has been installed/)
                })
        })

        it('removes the bad tree when a fresh clone fails verification', async () => {
            const { ms, fs } = loadWithGit({ revParse: async () => ({ stdout: OTHER_SHA + '\n' }) })
            await ms.cloneGit('xchain-vm', false, false, 'v0.9.0', PIN_SHA).catch(() => {})
            expect(fs.rmSync.calledWith('/modules/xchain-vm', sinon.match({ recursive: true, force: true }))).to.equal(true)
        })

        it('leaves an EXISTING checkout untouched when a rewrite fails verification', async () => {
            // The check runs against the staging tree, before the swap, so a moved
            // tag can never replace a good deploy checkout with a bad one.
            const { ms, fs, configService } = loadWithGit({ revParse: async () => ({ stdout: OTHER_SHA + '\n' }) })
            configService.moduleDirExists.returns(true)

            await ms.cloneGit('xchain-vm', true, false, 'v0.9.0', PIN_SHA).catch(() => {})

            expect(fs.renameSync.called).to.equal(false)
            const removedStaging = fs.rmSync.getCalls().some(c => String(c.args[0]).includes('.xchain-node-staging'))
            expect(removedStaging).to.equal(true)
        })

        it('skips verification entirely when no commit is pinned (branch install)', async () => {
            const revParse = sinon.stub().resolves({ stdout: OTHER_SHA + '\n' })
            const { ms } = loadWithGit({ revParse })
            const ok = await ms.cloneGit('xchain-vm', false, false, 'develop', null)
            expect(ok).to.equal(true)
            expect(revParse.called).to.equal(false)
        })

        it('cleans the tmp tree when a probe clone fails verification', async () => {
            const { ms, configService } = loadWithGit({ revParse: async () => ({ stdout: OTHER_SHA + '\n' }) })
            await ms.cloneGit('xchain-vm', false, true, 'v0.9.0', PIN_SHA).catch(() => {})
            expect(configService.removeModuleTmpDir.calledWith('xchain-vm')).to.equal(true)
        })
    })

    describe('resolveBundledLibRef()', () => {

        it('uses the manifest pin during a release install', async () => {
            releaseSvc.setActiveTarget(pinnedTarget({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } }))
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: 'master\n' }) })

            const ref = await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
            expect(ref).to.deep.equal({ ref: 'v0.9.0', commit: PIN_SHA, pinned: true, reason: 'release manifest' })
        })

        it('INHERITS the parent module ref when no release is active', async () => {
            // `install develop xchain-indexer` must stage develop's xchain-vm.
            // Before this, it staged the default branch's, whatever that was.
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: 'develop\n' }) })

            const ref = await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
            expect(ref.ref).to.equal('develop')
            expect(ref.pinned).to.equal(false)
            expect(ref.reason).to.equal('inherited from xchain-indexer')
        })

        it('inherits a feature branch too, not just the well-known ones', async () => {
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: 'feature/gas-rounding\n' }) })
            const ref = await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
            expect(ref.ref).to.equal('feature/gas-rounding')
        })

        it('falls back to the default branch only on a detached parent with no manifest', async () => {
            sinon.stub(console, 'warn')
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: 'HEAD\n' }) })
            const ref = await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
            expect(ref.ref).to.equal('master')
            expect(ref.reason).to.equal('default branch fallback')
        })

        it('announces the default-branch fallback rather than taking it silently', async () => {
            const warn = sinon.stub(console, 'warn')
            const { ms } = loadWithGit({ revParse: async () => ({ stdout: 'HEAD\n' }) })
            await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
            expect(warn.called).to.equal(true)
        })

        it('falls back when the parent is not checked out at all', async () => {
            sinon.stub(console, 'warn')
            const { ms } = loadWithGit({ revParse: async () => { throw new Error('not a git repository') } })
            const ref = await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
            expect(ref.ref).to.equal('master')
        })

        it('NEVER returns a null ref, on any path', async () => {
            // The regression this whole change exists to prevent: a null ref reaches
            // `git clone` with no -b flag, which is the remote's default branch.
            sinon.stub(console, 'warn')
            const cases = ['master\n', 'develop\n', 'HEAD\n', 'feature/x\n']
            for (const stdout of cases) {
                const { ms } = loadWithGit({ revParse: async () => ({ stdout }) })
                const ref = await ms.resolveBundledLibRef('xchain-indexer', 'xchain-vm')
                expect(ref.ref, `ref for parent on ${stdout.trim()}`).to.be.a('string').and.not.empty
            }
        })
    })

    describe('source-level guard', () => {

        it('stages no bundled library with a null ref', () => {
            // A source scan, deliberately: the defect was a single literal `null`
            // argument that every test passed straight through, and the cheapest
            // durable guard is that the literal cannot come back.
            const src = fsReal.readFileSync(
                pathReal.join(__dirname, '..', '..', 'src', 'services', 'ModuleService.js'), 'utf8')
            expect(src).to.not.match(/cloneGit\(\s*lib\s*,[^)]*,\s*null\s*\)/)
        })
    })
})
