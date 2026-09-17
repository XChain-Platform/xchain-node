'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deploy-time migration precondition guard: refuse the deploy when the
// target database hasn't applied a gated migration a service's new source
// asserts, before the container is recreated; stay inert everywhere else,
// or every routine deploy starts failing.

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../src/config')
const {
    MIGRATION_BEARING_MODULES,
    SKIP_ENV,
    migrationDeclaresDeployPrecondition,
    migrationMode,
    listDeployPreconditionMigrations,
    pendingManualMigrations,
    readAppliedMigrations,
    assertRequiredMigrationsApplied
} = require('../../src/services/migration_precondition_service')
const registerMigrationMetadata = require('./migration_precondition_service.test/01_migration_metadata.test')
const registerMigrationInventory = require('./migration_precondition_service.test/02_migration_inventory.test')
const registerAppliedLedger = require('./migration_precondition_service.test/03_applied_ledger.test')
const registerGuardOutcomes = require('./migration_precondition_service.test/04_guard_outcomes.test')

const GATED = '2026-07-24-pubkeys-widen-uncompressed.sql'

const TAGGED   = '-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE pubkeys MODIFY pubkey VARCHAR(130) NOT NULL;\n'
const UNTAGGED = '-- xchain:migration mode=manual\nALTER TABLE pubkeys MODIFY pubkey VARCHAR(130) NOT NULL;\n'

// xchain-indexer as a checkout, not just the migrations directory these tests
// read from it: a present checkout missing the pinned directory is a moved or
// renamed tree, while an absent checkout is a standalone install with no
// sibling to compare against.
const INDEXER_DIR        = path.join(__dirname, '../../../xchain-indexer')
const INDEXER_MIGRATIONS = require('../../src/utils/migration_files').migrationsDirOf(INDEXER_DIR)
const INDEXER_PRESENT    = fs.existsSync(INDEXER_DIR)
const REQUIRE_SIBLINGS   = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'

function makeDeps({ required = [GATED], applied = [GATED], state = 'ledger', reason = 'connection refused', cloneErr = null,
                    supportsPerFile = true, pendingManual = null } = {}) {
    return {
        cloneGit: cloneErr ? sinon.stub().rejects(cloneErr) : sinon.stub().resolves(),
        listDeployPreconditionMigrations: sinon.stub().returns(required),
        readAppliedMigrations: sinon.stub().resolves(
            state === 'ledger' ? { state: 'ledger', applied: new Set(applied) } : { state, reason }),
        // The remedy the refusal prints runs on the build inside the container,
        // not the one being deployed, so what that build can do is an input to
        // the message and therefore stubbed here.
        runningBuildSupportsPerFileMigrations: sinon.stub().resolves(supportsPerFile),
        pendingManualMigrations: sinon.stub().returns(pendingManual === null ? [GATED] : pendingManual)
    }
}

describe('MigrationPreconditionService', () => {

    beforeEach(() => { registerGuardOutcomes.setWarnStub(sinon.stub(console, 'warn')) })
    afterEach(() => {
        registerGuardOutcomes.restoreWarnStub()
        delete process.env[SKIP_ENV]
    })

    const deps = {
        fs, os, path, sinon, expect, XChainService,
        MIGRATION_BEARING_MODULES, SKIP_ENV,
        migrationDeclaresDeployPrecondition, migrationMode,
        listDeployPreconditionMigrations, pendingManualMigrations,
        readAppliedMigrations, assertRequiredMigrationsApplied,
        GATED, TAGGED, UNTAGGED, INDEXER_DIR, INDEXER_MIGRATIONS,
        INDEXER_PRESENT, REQUIRE_SIBLINGS, makeDeps
    }

    registerMigrationMetadata(deps)
    registerMigrationInventory(deps)
    registerAppliedLedger(deps)
    registerGuardOutcomes(deps)
})
