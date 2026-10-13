'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The precondition guard must read the ledger of the operator-configured
// database, not the derived default name.

const sinon      = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../src/config')
const { assertRequiredMigrationsApplied } = require('../../src/services/migration_precondition_service')
const { getModuleDatabaseName } = require('../../src/services/config_service')

const GATED = '2026-07-24-pubkeys-widen-uncompressed.sql'

function deps(cfg) {
    return {
        cloneGit: sinon.stub().resolves(),
        listDeployPreconditionMigrations: sinon.stub().returns([GATED]),
        readAppliedMigrations: sinon.stub().resolves({ state: 'ledger', applied: new Set([GATED]) }),
        getDefaultConfig: sinon.stub().resolves(cfg)
    }
}

describe('migration precondition configured database name', () => {
    it('reads the ledger of INDEXER_DB_NAME when configured', async () => {
        const d = deps({ INDEXER_DB_NAME: 'custom_idx' })
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', null, d)
        expect(d.readAppliedMigrations.firstCall.args[0].database).to.equal('custom_idx')
    })

    it('reads the ledger of DECODER_DB_NAME when configured', async () => {
        const d = deps({ DECODER_DB_NAME: 'custom_dec' })
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet', null, d)
        expect(d.readAppliedMigrations.firstCall.args[0].database).to.equal('custom_dec')
    })

    it('falls back to the derived default name when none is configured', async () => {
        const d = deps({})
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', null, d)
        expect(d.readAppliedMigrations.firstCall.args[0].database)
            .to.equal(getModuleDatabaseName(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet'))
    })

    it('names the configured database in the refusal', async () => {
        const d = deps({ INDEXER_DB_NAME: 'custom_idx' })
        d.readAppliedMigrations.resolves({ state: 'unreadable', reason: 'down' })
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', null, d)
            expect.fail('should refuse')
        } catch (err) {
            expect(err.message).to.contain('custom_idx')
        }
    })
})
