'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hub version-skew guard on the update path. The guard must refuse
// updating a hub-dependent service whose declared minimum hub version is
// ahead of the installed hub, and stay inert everywhere else.

const sinon      = require('sinon')
const { expect } = require('chai')

const { XChainService, EXPLORER_MODULE_NAME } = require('../../src/config/constants')
const {
    compareVersions,
    getRequiredHubVersion,
    assertHubNotBehind,
    HUB_DEPENDENT_MODULES,
    SKIP_ENV
} = require('../../src/services/SkewGuardService')

const HUB_CID = 'c'.repeat(64)

function makeDeps({ pkg = {}, hubContainer = HUB_CID, hubVersion = '2.2.17', hubVersionErr = null, cloneErr = null } = {}) {
    return {
        cloneGit: cloneErr ? sinon.stub().rejects(cloneErr) : sinon.stub().resolves(),
        readPackageJson: sinon.stub().returns(pkg),
        getHubContainer: sinon.stub().resolves(hubContainer),
        getHubVersion: hubVersionErr ? sinon.stub().rejects(hubVersionErr) : sinon.stub().resolves(hubVersion)
    }
}

describe('SkewGuardService', () => {
    let warnStub
    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => {
        warnStub.restore()
        delete process.env[SKIP_ENV]
    })

    describe('compareVersions', () => {
        it('orders numerically, not lexically', () => {
            expect(compareVersions('2.2.10', '2.2.9')).to.equal(1)
            expect(compareVersions('2.2.9', '2.2.10')).to.equal(-1)
        })
        it('treats equal versions as equal, with or without v prefix', () => {
            expect(compareVersions('v2.2.0', '2.2.0')).to.equal(0)
        })
        it('pads missing segments with zero', () => {
            expect(compareVersions('2.2', '2.2.0')).to.equal(0)
            expect(compareVersions('2.3', '2.2.17')).to.equal(1)
        })
    })

    describe('getRequiredHubVersion', () => {
        it('returns null when the field is absent', () => {
            expect(getRequiredHubVersion({ version: '1.0.0' })).to.equal(null)
            expect(getRequiredHubVersion(null)).to.equal(null)
        })
        it('returns the trimmed version when declared', () => {
            expect(getRequiredHubVersion({ xchainRequiresHub: 'v2.2.0' })).to.equal('2.2.0')
        })
        it('throws on a non-version value (range syntax not supported)', () => {
            expect(() => getRequiredHubVersion({ xchainRequiresHub: '>=2.2.0' })).to.throw(/xchainRequiresHub/)
            expect(() => getRequiredHubVersion({ xchainRequiresHub: { min: '1' } })).to.throw(/xchainRequiresHub/)
        })
    })

    describe('assertHubNotBehind', () => {
        it('skips non-hub-dependent modules without cloning', async () => {
            const deps = makeDeps()
            const res = await assertHubNotBehind(XChainService.XCHAIN_DECODER, null, deps)
            expect(res.checked).to.equal(false)
            expect(deps.cloneGit.called).to.equal(false)
        })

        it('lists indexer, explorer and sync as hub-dependent', () => {
            expect(HUB_DEPENDENT_MODULES).to.include(XChainService.XCHAIN_INDEXER)
            expect(HUB_DEPENDENT_MODULES).to.include(EXPLORER_MODULE_NAME)
        })

        it('proceeds when the module declares no constraint', async () => {
            const deps = makeDeps({ pkg: { version: '2.7.17' } })
            const res = await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
            expect(res).to.deep.include({ checked: false, reason: 'no-constraint' })
            expect(deps.getHubContainer.called).to.equal(false)
        })

        it('REFUSES when the installed hub is behind the required version', async () => {
            const deps = makeDeps({ pkg: { xchainRequiresHub: '2.3.0' }, hubVersion: '2.2.17' })
            try {
                await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
                throw new Error('expected refusal')
            } catch (err) {
                expect(err.message).to.match(/update refused/)
                expect(err.message).to.match(/requires hub >= 2\.3\.0/)
                expect(err.message).to.match(/installed hub is 2\.2\.17/)
            }
        })

        it('passes when the installed hub meets or exceeds the required version', async () => {
            const deps = makeDeps({ pkg: { xchainRequiresHub: '2.2.0' }, hubVersion: '2.2.17' })
            const res = await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
            expect(res).to.deep.include({ checked: true, ok: true, requiredHub: '2.2.0', hubVersion: '2.2.17' })
        })

        it('REFUSES (fail-closed) when the hub is installed but its version is unreadable', async () => {
            const deps = makeDeps({ pkg: { xchainRequiresHub: '2.2.0' }, hubVersionErr: new Error('no such container') })
            try {
                await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
                throw new Error('expected refusal')
            } catch (err) {
                expect(err.message).to.match(/update refused/)
                expect(err.message).to.match(/could not be read/)
            }
        })

        it('proceeds with a warning on a hubless stack', async () => {
            const deps = makeDeps({ pkg: { xchainRequiresHub: '2.2.0' }, hubContainer: null })
            const res = await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
            expect(res).to.deep.include({ checked: true, ok: true, hubVersion: null })
            expect(warnStub.calledWithMatch(/no hub is installed/)).to.equal(true)
        })

        it('proceeds when the module source cannot be cloned (update will fail there anyway)', async () => {
            const deps = makeDeps({ cloneErr: new Error('git down') })
            const res = await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
            expect(res).to.deep.include({ checked: false, reason: 'manifest-unreadable' })
        })

        it('threads the requested branch into the tmp clone', async () => {
            const deps = makeDeps({ pkg: {} })
            await assertHubNotBehind(XChainService.XCHAIN_INDEXER, 'release-2.8', deps)
            expect(deps.cloneGit.calledWith(XChainService.XCHAIN_INDEXER, false, true, 'release-2.8')).to.equal(true)
        })

        it('honors the skip env var, loudly', async () => {
            process.env[SKIP_ENV] = '1'
            const deps = makeDeps({ pkg: { xchainRequiresHub: '99.0.0' } })
            const res = await assertHubNotBehind(XChainService.XCHAIN_INDEXER, null, deps)
            expect(res).to.deep.include({ checked: false, reason: 'skipped-by-env' })
            expect(deps.cloneGit.called).to.equal(false)
            expect(warnStub.calledWithMatch(/skipping the hub version-skew guard/)).to.equal(true)
        })
    })
})
