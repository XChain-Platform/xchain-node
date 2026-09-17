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

const proxyquire = require('proxyquire').noCallThru()

let warnStub

function registerBasicGuardOutcomes({ expect, sinon, XChainService, MIGRATION_BEARING_MODULES, SKIP_ENV,
                                      assertRequiredMigrationsApplied, makeDeps, GATED }) {
    it('uses the moved default migration reader when no deps are passed', async () => {
        const cloneGit = sinon.stub().resolves()
        const listRequired = sinon.stub().returns([GATED])
        const readApplied = sinon.stub().resolves({ state: 'ledger', applied: new Set([GATED]) })
        const migrationScan = require('../../../src/services/migration_precondition_service/migration_scan')
        const service = proxyquire('../../../src/services/migration_precondition_service', {
            './module_service': { cloneGit },
            './migration_precondition_service/migration_scan': {
                ...migrationScan,
                listDeployPreconditionMigrations: listRequired,
                readAppliedMigrations: readApplied
            }
        })

        const res = await service.assertRequiredMigrationsApplied(
            XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master')

        expect(res.ok).to.equal(true)
        expect(cloneGit.calledOnce).to.equal(true)
        expect(listRequired.calledOnce).to.equal(true)
        expect(readApplied.calledOnce).to.equal(true)
    })

    it('is inert for a module that ships no migrations', async () => {
        const deps = makeDeps()
        const res = await assertRequiredMigrationsApplied(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet', 'master', deps)
        expect(res).to.deep.equal({ checked: false, reason: 'no-migrations' })
        expect(deps.cloneGit.called).to.equal(false)
    })

    it('covers the indexer and the decoder, the two migration-bearing modules', () => {
        expect(MIGRATION_BEARING_MODULES).to.have.members([XChainService.XCHAIN_INDEXER, XChainService.XCHAIN_DECODER])
    })

    it('proceeds, loudly, when the skip env is set', async () => {
        process.env[SKIP_ENV] = '1'
        const deps = makeDeps({ applied: [] })
        const res = await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        expect(res.reason).to.equal('skipped-by-env')
        expect(warnStub.called).to.equal(true)
    })
}

function registerMissingMigrationOutcomes({ expect, XChainService, assertRequiredMigrationsApplied,
                                            GATED, makeDeps }) {
    it('refuses when the target DB has not applied a declared precondition', async () => {
        const deps = makeDeps({ applied: ['2026-07-21-anchor-reward-attestations-table.sql'] })
        let err = null
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        } catch (e) { err = e }
        expect(err, 'the deploy must be refused').to.not.equal(null)
        expect(err.message).to.contain(GATED)
        expect(err.message).to.contain('XChain_BTC_Mainnet_Indexer')
        // Only safe to print because this build was confirmed to honour --file.
        expect(err.message).to.contain('--file ' + GATED)
    })

    it('does NOT print a scoped command the running build would ignore', async () => {
        // A build without per-file targeting does not reject --file, it ignores
        // it and applies every pending manual migration, so printing the command
        // hands the operator a wider action than the one it describes.
        const deps = makeDeps({
            applied: [],
            supportsPerFile: false,
            pendingManual: [GATED, '2026-08-10-action-data-utf8mb4.sql', '2026-06-13-dispensers-expiration-bigint.sql']
        })
        let err = null
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        } catch (e) { err = e }
        expect(err, 'the deploy must be refused').to.not.equal(null)
        expect(err.message).to.not.contain('docker exec')
        expect(err.message).to.contain('DO NOT run')
        // The whole blast radius is named, not just the file that is needed.
        expect(err.message).to.contain('3 file(s)')
        expect(err.message).to.contain('2026-08-10-action-data-utf8mb4.sql')
        expect(err.message).to.contain('2026-06-13-dispensers-expiration-bigint.sql')
        expect(err.message).to.contain('(the one you need)')
    })
}

function registerCapabilityProbeOutcomes({ sinon, expect, XChainService,
                                           assertRequiredMigrationsApplied, makeDeps }) {
    it('treats an unreadable container as lacking the capability', async () => {
        // An unverified capability is not a capability: the cost of guessing
        // wrong is an unauthorised migration on a live database.
        const deps = makeDeps({ applied: [], supportsPerFile: null })
        let err = null
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        } catch (e) { err = e }
        expect(err, 'the deploy must be refused').to.not.equal(null)
        expect(err.message).to.not.contain('docker exec')
        expect(err.message).to.contain('could not be read')
    })

    it('still refuses when the capability probe itself throws', async () => {
        const deps = makeDeps({ applied: [] })
        deps.runningBuildSupportsPerFileMigrations = sinon.stub().rejects(new Error('docker unreachable'))
        let err = null
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        } catch (e) { err = e }
        expect(err, 'the deploy must still be refused').to.not.equal(null)
        expect(err.message).to.contain('update refused')
        expect(err.message).to.not.contain('docker exec')
    })
}

function registerSuccessfulGuardOutcomes({ expect, XChainService, assertRequiredMigrationsApplied, makeDeps }) {
    it('reads the source tree about to be deployed, at the pinned ref', async () => {
        const deps = makeDeps()
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'release-1.2.3', deps)
        expect(deps.cloneGit.calledWith(XChainService.XCHAIN_INDEXER, false, true, 'release-1.2.3')).to.equal(true)
    })

    it('passes when every declared precondition is in the ledger', async () => {
        const deps = makeDeps()
        const res = await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        expect(res.ok).to.equal(true)
        expect(res.missing).to.deep.equal([])
    })

    it('does not touch the database when the target source declares no preconditions', async () => {
        const deps = makeDeps({ required: [] })
        const res = await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        expect(res).to.deep.equal({ checked: false, reason: 'no-preconditions' })
        expect(deps.readAppliedMigrations.called).to.equal(false)
    })

    it('proceeds on a genuinely empty database (a fresh install cannot be behind)', async () => {
        const deps = makeDeps({ state: 'empty-database' })
        const res = await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        expect(res.ok).to.equal(true)
        expect(res.reason).to.equal('empty-database')
    })
}

function registerFailureAndScopeOutcomes({ expect, XChainService, SKIP_ENV,
                                           assertRequiredMigrationsApplied, makeDeps }) {
    it('refuses when the migration state cannot be read, and says so is not the same as missing', async () => {
        const deps = makeDeps({ state: 'unreadable', reason: 'ECONNREFUSED 127.0.0.1:13306' })
        let err = null
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        } catch (e) { err = e }
        expect(err, 'an unknown migration state must fail closed').to.not.equal(null)
        expect(err.message).to.contain('could NOT be determined')
        expect(err.message).to.contain('ECONNREFUSED')
        expect(err.message).to.contain(SKIP_ENV)
    })

    it('proceeds with a warning when the source itself cannot be cloned', async () => {
        // The update is about to fail on the same clone; adding a second failure
        // mode here would only obscure the real one.
        const deps = makeDeps({ cloneErr: new Error('network down') })
        const res = await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
        expect(res).to.deep.equal({ checked: false, reason: 'source-unreadable' })
        expect(warnStub.called).to.equal(true)
    })

    it('checks the database belonging to the module, coin and network being updated', async () => {
        const deps = makeDeps()
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_DECODER, 'litecoin', 'testnet', 'master', deps)
        const arg = deps.readAppliedMigrations.firstCall.args[0]
        expect(arg.database).to.equal('XChain_LTC_Testnet_Decoder')
        expect(arg.coin).to.equal('litecoin')
        expect(arg.network).to.equal('testnet')
    })
}

function registerGuardOutcomes(deps) {
    describe('assertRequiredMigrationsApplied', () => {
        registerBasicGuardOutcomes(deps)
        registerMissingMigrationOutcomes(deps)
        registerCapabilityProbeOutcomes(deps)
        registerSuccessfulGuardOutcomes(deps)
        registerFailureAndScopeOutcomes(deps)
    })
}

registerGuardOutcomes.setWarnStub = (stub) => { warnStub = stub }
registerGuardOutcomes.restoreWarnStub = () => { warnStub.restore() }

module.exports = registerGuardOutcomes
