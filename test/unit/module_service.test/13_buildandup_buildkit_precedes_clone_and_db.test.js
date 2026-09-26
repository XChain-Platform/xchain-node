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

// A buildx-less host must fail on the BuildKit probe alone: before
// buildAndUp reads module configuration/database state and before it clones
// any bundled library into the build context.

const {
    sinon, expect, makeStubs, makeConfigServiceStub, loadModuleService, moduleSuite
} = require('./support/helpers')

moduleSuite('buildAndUp(): BuildKit probe precedes clone and database work', function () {
    // proxyquire's module_service load sits under the 2s CLI default only while
    // the runner is idle; concurrent gate runs push it over (same budget as
    // 06_buildandup_module_specific_port_volume_branches.test.js).
    this.timeout(10000)

    it('refuses on the buildx probe before configuration/database lookup or the bundled-library clone', async function () {
        const stubs = makeStubs()
        const calls = []
        const hint = "Docker's buildx plugin is not installed: sudo apt install docker-buildx-plugin"
        stubs.checkBuildKitAvailable = sinon.stub().callsFake(async () => {
            calls.push('buildx')
            throw hint
        })

        const configService = makeConfigServiceStub()
        configService.getDefaultConfig = sinon.stub().callsFake(async () => {
            calls.push('configuration/database')
            return {}
        })

        const cloneGit = sinon.stub().callsFake(async () => { calls.push('clone') })
        const resolveBundledLibRef = sinon.stub().resolves(
            { ref: 'develop', commit: null, pinned: false, reason: 'default branch fallback' })

        const ms = loadModuleService(stubs, null, {
            './config_service': configService,
            './module_service/clone_and_refs.js': {
                configureDependencies: sinon.stub(),
                cloneGit, resolveBundledLibRef,
                getModuleBranch: sinon.stub().resolves('develop'),
                getModuleCommit: sinon.stub().resolves(null)
            }
        })

        let thrown = null
        try {
            // xchain-indexer bundles xchain-vm, so a fix that lets configuration
            // or the clone run first would show up here.
            await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet')
            expect.fail('Should have rejected without buildx')
        } catch (err) { thrown = err }

        expect(String(thrown)).to.include('Error creating Docker image')
        expect(String(thrown)).to.include('docker-buildx-plugin')
        expect(calls).to.deep.equal(['buildx'])
        expect(configService.getDefaultConfig.called).to.equal(false)
        expect(cloneGit.called).to.equal(false)
        expect(resolveBundledLibRef.called).to.equal(false)
    })
})
