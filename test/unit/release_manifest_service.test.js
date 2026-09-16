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

const PIN_SHA   = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

function makeStubs() {
    return {
        axiosGet: sinon.stub(),
        readFileSync: sinon.stub().throws(new Error('ENOENT')),
        // The provenance gate is exercised for real (gpg and all) in
        // ReleaseSignatureService.test.js. Here it is stubbed so these cases stay
        // about manifest RESOLUTION, and asserted on so the wiring cannot be
        // removed silently: an unverified manifest is the defect this whole
        // service was rebuilt to prevent.
        verifyManifestForTag: sinon.stub().resolves({ verified: true, fingerprint: 'F'.repeat(40) })
    }
}

function load(stubs) {
    return proxyquire('../../src/services/release_manifest_service', {
        'fs':    { readFileSync: stubs.readFileSync },
        'axios': { get: stubs.axiosGet },
        './github_downloader': {
            githubApiHeaders:     () => ({}),
            githubRateLimitError: () => null
        },
        './release_signature_service': {
            verifyManifestForTag: stubs.verifyManifestForTag
        }
    })
}

function manifest(components = {}) {
    return { platform_version: '0.9.0', released: '2026-08-20', components }
}

let stubs, svc

function serviceSuite(title, tests) {
    describe('ReleaseManifestService', () => {
        beforeEach(() => {
            stubs = makeStubs()
            svc   = load(stubs)
        })
        afterEach(() => {
            svc.clearActiveTarget()
            sinon.restore()
        })
        describe(title, tests)
    })
}

serviceSuite('isReleaseRef()', () => {
    // The whole no-new-CLI-field design rests on this classification, so the
    // shapes that must NOT be releases are as load-bearing as the ones that must.
    const releases = ['v0.9.0', 'v1.0.0', 'v10.20.30', 'v1.0.0-rc.1', 'v0.9.0+build.5']
    const branches = ['master', 'develop', 'v0.9', 'v0.9.0.1', 'release/v0.9.0',
                      'hotfix/v0.9.1', 'feature/v2-rewrite', '']

    releases.forEach(ref => it(`classifies ${ref} as a release`, () => {
        expect(svc.isReleaseRef(ref)).to.equal(true)
    }))

    branches.forEach(ref => it(`classifies '${ref}' as NOT a release`, () => {
        expect(svc.isReleaseRef(ref)).to.equal(false)
    }))

    it('classifies a legacy bare component version as a branch, not a release', () => {
        // xchain-indexer really was 2.7.17 before the adoption jump; without the
        // mandatory leading `v` a branch of that name would silently become a
        // release lookup.
        expect(svc.isReleaseRef('2.7.17')).to.equal(false)
    })

    it('rejects non-strings', () => {
        expect(svc.isReleaseRef(null)).to.equal(false)
        expect(svc.isReleaseRef(undefined)).to.equal(false)
        expect(svc.isReleaseRef(42)).to.equal(false)
    })
})

serviceSuite('manifestHasPins()', () => {
    it('is false for the shipped pre-first-train manifest', () => {
        expect(svc.manifestHasPins({ platform_version: null, components: {} })).to.equal(false)
    })

    it('is false for null and for a manifest with no components key', () => {
        expect(svc.manifestHasPins(null)).to.equal(false)
        expect(svc.manifestHasPins({})).to.equal(false)
    })

    it('is true once a component is pinned', () => {
        expect(svc.manifestHasPins(manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } }))).to.equal(true)
    })
})

serviceSuite('getComponentPin()', () => {
    it('returns the tag and commit for a pinned component', () => {
        const m = manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        expect(svc.getComponentPin(m, 'xchain-vm')).to.deep.equal({ tag: 'v0.9.0', commit: PIN_SHA })
    })

    it('returns null for a component the manifest does not carry', () => {
        const m = manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        expect(svc.getComponentPin(m, 'xchain-wallet')).to.equal(null)
    })

    it('returns null for an empty manifest rather than inventing a pin', () => {
        expect(svc.getComponentPin({ components: {} }, 'xchain-vm')).to.equal(null)
    })

    it('THROWS when a pin has no commit', () => {
        // A tag alone does not pin: it is mutable by the repo owner. A manifest
        // entry that carries only a tag must fail the install loudly rather than
        // degrade to "clone whatever the tag points at now".
        const m = manifest({ 'xchain-vm': { tag: 'v0.9.0' } })
        expect(() => svc.getComponentPin(m, 'xchain-vm')).to.throw(/no usable commit id/)
    })

    it('THROWS when a pin has a malformed commit', () => {
        const m = manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: 'deadbeef' } })
        expect(() => svc.getComponentPin(m, 'xchain-vm')).to.throw(/no usable commit id/)
    })
})

serviceSuite('resolveComponentRef()', () => {
    it('returns the fallback ref, unpinned, when no install is active', () => {
        expect(svc.resolveComponentRef('xchain-vm', 'develop'))
            .to.deep.equal({ ref: 'develop', commit: null, pinned: false })
    })

    it('returns the fallback ref when the active install is a branch install', () => {
        svc.setActiveTarget({ kind: 'branch', ref: 'develop', manifest: null })
        expect(svc.resolveComponentRef('xchain-vm', 'develop').pinned).to.equal(false)
    })

    it('returns the manifest pin during a release install', () => {
        svc.setActiveTarget({
            kind: 'release', tag: 'v0.9.0',
            manifest: manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        })
        expect(svc.resolveComponentRef('xchain-vm', 'develop'))
            .to.deep.equal({ ref: 'v0.9.0', commit: PIN_SHA, pinned: true })
    })

    it('OVERRIDES a caller-supplied fallback during a release install', () => {
        // This is the property that closes the bundled-library fork vector: the
        // pin wins over whatever branch the surrounding code would have used.
        svc.setActiveTarget({
            kind: 'release', tag: 'v0.9.0',
            manifest: manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        })
        expect(svc.resolveComponentRef('xchain-vm', 'master').ref).to.equal('v0.9.0')
    })

    it('falls back for a component the release does not pin', () => {
        svc.setActiveTarget({
            kind: 'release', tag: 'v0.9.0',
            manifest: manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        })
        expect(svc.resolveComponentRef('xchain-dashboard', 'master'))
            .to.deep.equal({ ref: 'master', commit: null, pinned: false })
    })

    it('clearActiveTarget() ends pinned mode', () => {
        svc.setActiveTarget({
            kind: 'release', tag: 'v0.9.0',
            manifest: manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        })
        svc.clearActiveTarget()
        expect(svc.resolveComponentRef('xchain-vm', 'master').pinned).to.equal(false)
    })
})

serviceSuite('resolveLatestReleaseTag()', () => {
    it('returns the tag from releases/latest', async () => {
        stubs.axiosGet.resolves({ data: { tag_name: 'v0.9.0' } })
        expect(await svc.resolveLatestReleaseTag()).to.equal('v0.9.0')
        expect(stubs.axiosGet.firstCall.args[0]).to.match(/repos\/XChain-Platform\/xchain-node\/releases\/latest$/)
    })

    it('returns null (not an error) when no release has been published yet', async () => {
        // Pre-first-train this is the normal state of the world.
        const err = new Error('Not Found'); err.response = { status: 404 }
        stubs.axiosGet.rejects(err)
        expect(await svc.resolveLatestReleaseTag()).to.equal(null)
    })

    it('propagates a non-404 failure rather than reporting "no release"', async () => {
        // A 500 must not be mistaken for "nothing published": that would
        // silently downgrade a pinned install to a branch install.
        const err = new Error('boom'); err.response = { status: 500 }
        stubs.axiosGet.rejects(err)
        await svc.resolveLatestReleaseTag().then(
            () => { throw new Error('should have rejected') },
            e => expect(e.message).to.equal('boom'))
    })
})
