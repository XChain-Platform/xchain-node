/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Migration Precondition Guard
 *
 * Deploy-time precondition check for services that assert a GATED schema
 * migration at startup. Refuses the update BEFORE the container is recreated,
 * naming the migration, instead of letting the service discover the requirement
 * by crash-looping on boot.
 *
 * WHY IT EXISTS
 * -------------
 * 2026-08-09: a routine indexer deploy put all three mainnet indexers (BTC on
 * one host, DOGE and LTC on another) into Restarting(1) crash-loops with
 * `Fatal indexer error: pubkeys.pubkey holds 66 chars but VARCHAR(130) is
 * required`. The new code asserts that column width at startup; the migration
 * that widens it is mode=manual (a COPY table rebuild under a metadata lock, so
 * it wants the writer quiesced) and had never been applied on mainnet. Both
 * halves were correct in isolation. The defect was that nothing asked the
 * question at deploy time, so a production outage was the discovery mechanism.
 *
 * SOURCE OF TRUTH FOR THE CONSTRAINT
 * ----------------------------------
 * A header tag on the migration file itself, in the source tree about to be
 * deployed:
 *
 *     -- xchain:migration mode=manual deploy-precondition=required
 *
 * Same shape as the SkewGuardService contract (`xchainRequiresHub` in the
 * module's own package.json): the constraint travels with the code that carries
 * the assertion, so a new assertion is covered the moment it lands and no
 * xchain-node release is needed to track it. The service-side half of the
 * contract is xchain-indexer's Database.STARTUP_ASSERTED_MIGRATIONS, whose unit
 * suite fails if a registered assertion's migration is missing this tag.
 *
 * WHAT IT CHECKS
 * --------------
 * Every tagged migration in the target tree must have a `schema_migrations` row
 * in the database that service will use. Missing row -> refuse. Cannot tell ->
 * refuse (an unknown migration state is exactly the situation that produced the
 * outage). Genuinely empty database -> proceed; a fresh install builds its
 * schema from src/sql at the current widths and can never be behind.
 ********************************************************************/

const { XChainService } = require('../config')
const { migrationsDirOf } = require('../utils/migration_files')
const { getModuleTmpDir, getModuleDatabaseName, getDockerContainerImageName } = require('./config_service')
const config = require('../config');
const { getLogger } = require('../observability/logger');
const logger = getLogger();
const {
    migrationDeclaresDeployPrecondition,
    migrationMode,
    pendingManualMigrations,
    runningBuildSupportsPerFileMigrations,
    listDeployPreconditionMigrations,
    readAppliedMigrations,
    refusalMessage
} = require('./migration_precondition_service/migration_scan')

// Only these modules ship a migrations directory, so everything else skips the
// guard entirely and costs the update path nothing.
const MIGRATION_BEARING_MODULES = [
    XChainService.XCHAIN_INDEXER,
    XChainService.XCHAIN_DECODER
]

const SKIP_ENV     = 'XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION'

function guardSkipped() {
    // Read BY NAME, not through SKIP_ENV, even though the constant is right
    // there: the documentation coverage gate scans for literal `process.env.X`
    // and a computed read is invisible to it, so a bracket read here is
    // undocumentable configuration by construction. SKIP_ENV stays as the name
    // used in messages.
    const v = config.XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION
    return v === '1' || v === 'true' || v === 'yes'
}

function emptyDatabaseResult(module, dbName, required) {
    logger.warn(`Migration precondition guard: ${dbName} holds no tables yet, so ${module}'s gated ` +
        `migrations (${required.join(', ')}) cannot be outstanding on it; proceeding.`)
    return { checked: true, required, ok: true, reason: 'empty-database' }
}

function assertMigrationStateReadable(result, module, dbName, required) {
    if (result.state === 'ledger') return
    // Say which situation this is. "Apply the migration" would be advice this
    // branch cannot justify: what failed is reading the ledger, not the ledger
    // reporting a gap.
    throw new Error(
        `update refused: ${module} asserts migration(s) ${required.join(', ')} at startup, and whether ` +
        `${dbName} has applied ${required.length > 1 ? 'them' : 'it'} could NOT be determined ` +
        `(${result.reason}). This is an unknown-state refusal, not a known-missing migration. Check the ` +
        `database is up and that this host can reach it, then re-run; set ${SKIP_ENV}=1 to override once ` +
        `you know the schema is current.`
    )
}

/**
 * Refuses (throws) when the source tree about to be deployed declares a migration
 * as a startup precondition that the target database has not applied.
 *
 * Fail-closed rules:
 *  - precondition declared + ledger says missing        -> refuse
 *  - precondition declared + ledger unreadable          -> refuse (unknown state)
 *  - precondition declared + database empty / absent    -> proceed (fresh install)
 *  - no precondition declared / not migration-bearing   -> proceed
 *  - the target source cannot be read at all            -> proceed with a warning
 *    (the update is about to fail the same way; do not add a second failure mode)
 *
 * `deps` is injectable for tests; production callers pass nothing.
 */
async function assertRequiredMigrationsApplied(module, coin, network, branch = null, deps = {}) {
    if (!MIGRATION_BEARING_MODULES.includes(module)) return { checked: false, reason: 'no-migrations' }
    if (guardSkipped()) {
        logger.warn(`WARNING: ${SKIP_ENV} is set; skipping the migration precondition check for ${module}. ` +
            'A service whose startup assertion needs an unapplied migration crash-loops as soon as the container is recreated.')
        return { checked: false, reason: 'skipped-by-env' }
    }

    const cloneGitDep  = deps.cloneGit || require('./module_service').cloneGit
    const listRequired = deps.listDeployPreconditionMigrations || listDeployPreconditionMigrations
    const readApplied  = deps.readAppliedMigrations || defaultReadAppliedMigrations

    // Clone the target source and read ITS migrations: the constraint must come
    // from the code that is about to run. The tmp tree is NOT reused from the skew
    // guard even when that just cloned the same ref - that guard is conditional
    // (module set, skip env, early returns), so a leftover tree can be from another
    // branch or another run, and reading the wrong tree is how a precondition check
    // blesses a version it never saw.
    let required
    try {
        await cloneGitDep(module, false, true, branch)
        required = listRequired(migrationsDirOf(getModuleTmpDir(module)))
    } catch (err) {
        logger.warn(`Migration precondition guard: could not read ${module}'s migrations ` +
            `(${err && err.message ? err.message : err}); guard not applied.`)
        return { checked: false, reason: 'source-unreadable' }
    }
    if (!required.length) return { checked: false, reason: 'no-preconditions' }

    const dbName = getModuleDatabaseName(module, coin, network)
    const result = await readApplied({ database: dbName, coin, network })

    if (result.state === 'empty-database') return emptyDatabaseResult(module, dbName, required)
    assertMigrationStateReadable(result, module, dbName, required)

    const missing = required.filter(f => !result.applied.has(f))
    if (missing.length) {
        // Only reached on the refusal path, so the probe costs a healthy deploy
        // nothing and cannot introduce a new way for one to fail: both the probe
        // and the pending-scan degrade to the cautious branch of the message.
        const container   = getDockerContainerImageName(module, coin, network)
        const probe       = deps.runningBuildSupportsPerFileMigrations || runningBuildSupportsPerFileMigrations
        const listPending = deps.pendingManualMigrations || pendingManualMigrations
        let supportsPerFile = null
        let pendingManual   = []
        try {
            supportsPerFile = await probe(container, deps)
            pendingManual   = listPending(migrationsDirOf(getModuleTmpDir(module)), result.applied)
        } catch {
            supportsPerFile = null
        }
        throw new Error(refusalMessage(module, coin, network, dbName, missing, { supportsPerFile, pendingManual }))
    }

    return { checked: true, required, missing: [], ok: true }
}

module.exports = {
    MIGRATION_BEARING_MODULES,
    SKIP_ENV,
    migrationDeclaresDeployPrecondition,
    migrationMode,
    listDeployPreconditionMigrations,
    pendingManualMigrations,
    runningBuildSupportsPerFileMigrations,
    // Exported for the unit suite: the refusal path hinges on an unreachable
    // database returning `unreadable` rather than throwing past the guard, and
    // that is a property of the real driver call, not of a stub.
    readAppliedMigrations,
    assertRequiredMigrationsApplied
}
