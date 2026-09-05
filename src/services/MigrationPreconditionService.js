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

const fs   = require('fs')
const path = require('path')

const { XChainService, EXTERNAL_DB } = require('../config/constants')
const { getModuleTmpDir, getModuleDatabaseName, getDockerContainerImageName } = require('./ConfigService')

// Only these modules ship a migrations directory, so everything else skips the
// guard entirely and costs the update path nothing.
const MIGRATION_BEARING_MODULES = [
    XChainService.XCHAIN_INDEXER,
    XChainService.XCHAIN_DECODER
]

const SKIP_ENV     = 'XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION'
const LEDGER_TABLE = 'schema_migrations'

function guardSkipped() {
    // Read BY NAME, not through SKIP_ENV, even though the constant is right
    // there: the documentation coverage gate scans for literal `process.env.X`
    // and a computed read is invisible to it, so a bracket read here is
    // undocumentable configuration by construction. SKIP_ENV stays as the name
    // used in messages.
    const v = process.env.XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION
    return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Does this migration file's header declare itself a deploy precondition?
 *
 * Prologue-anchored: the scan stops at the first non-blank, non-comment line, so
 * the token can only arm the flag from the leading comment block and never from
 * body prose or a data literal. Widening that to the whole file is how a
 * migration that merely DISCUSSES the convention would start refusing deploys.
 *
 * Twin of xchain-indexer's Database.migrationDeclaresDeployPrecondition. It is
 * duplicated rather than shared because this tool reads these files out of a
 * source tree it has only cloned, with that tree's dependencies uninstalled, so
 * requiring the module is not available to it. Keep the two in step.
 */
function migrationDeclaresDeployPrecondition(raw) {
    const prologue = []
    for (const line of String(raw).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('--')) { prologue.push(line); continue }
        break
    }
    return /^\s*--\s*xchain:migration\b[^\n]*\bdeploy-precondition\s*=\s*required\b/im.test(prologue.join('\n'))
}

/**
 * The `mode=` a migration header declares, or null when it declares none.
 * Prologue-anchored exactly like migrationDeclaresDeployPrecondition, so a token
 * in body prose or a data literal cannot answer for the file.
 *
 * Twin of the modules' own Database._migrationMode, duplicated for the reason
 * given above: this tool reads a cloned tree whose dependencies are not
 * installed. Keep them in step.
 */
function migrationMode(raw) {
    const prologue = []
    for (const line of String(raw).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('--')) { prologue.push(line); continue }
        break
    }
    const m = prologue.join('\n').match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*([A-Za-z]+)/im)
    return m ? m[1].toLowerCase() : null
}

/**
 * Every gated (mode=manual) migration in `dir` that the ledger has not recorded,
 * sorted. This is the blast radius of an UNSCOPED migrate run against that
 * database: the runner applies every pending manual file, not just the one an
 * operator names. The refusal names that whole set, so the consequence is on
 * screen rather than left for the operator to discover.
 */
function pendingManualMigrations(dir, applied) {
    let files
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    } catch {
        return []
    }
    return files.filter(f => {
        if (applied && applied.has(f)) return false
        try {
            return migrationMode(fs.readFileSync(path.join(dir, f), 'utf8')) === 'manual'
        } catch {
            return false
        }
    })
}

/**
 * Does the build CURRENTLY RUNNING in the target container understand per-file
 * migration targeting (`--file`)?
 *
 * This matters because the remedy an operator is about to run executes inside
 * that container, on its build, not on the one being deployed. A build without
 * the flag does not reject it: it ignores it and applies every pending manual
 * migration, which on a live database can mean a data backfill and a
 * dedup-then-unique nobody authorised.
 *
 * Returns true, false, or null when the container could not be read at all
 * (stopped, absent, docker unreachable). Callers must treat null like false:
 * an unverified capability is not a capability, and the cost of being wrong is
 * asymmetric.
 */
async function runningBuildSupportsPerFileMigrations(container, deps = {}) {
    try {
        const cat = deps.getDockerContainerFileCat || require('./DockerService').getDockerContainerFileCat
        const source = await cat(container, 'src/migrate.js')
        if (!source) return null
        return /['"]--file['"]/.test(String(source))
    } catch {
        return null
    }
}

/**
 * Every migration filename in `dir` whose header declares a deploy precondition,
 * sorted. A missing directory yields [] - a module (or a ref) with no migrations
 * declares no preconditions, which is not an error.
 */
function listDeployPreconditionMigrations(dir) {
    let files
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    } catch {
        return []
    }
    return files.filter(f => {
        try {
            return migrationDeclaresDeployPrecondition(fs.readFileSync(path.join(dir, f), 'utf8'))
        } catch {
            return false
        }
    })
}

/**
 * Read the applied-migration ledger of one module database.
 *
 * Returns { state: 'ledger', applied: Set<string> } when the ledger was read,
 * { state: 'empty-database' } when the schema holds no tables at all (or does
 * not exist yet), and { state: 'unreadable', reason } for everything else. The
 * three are deliberately distinct: only the middle one is safe to proceed on.
 *
 * WHY ROOT AND NOT THE MODULE'S OWN ACCOUNT
 * -----------------------------------------
 * The first cut of this guard connected with the module's generated credentials
 * (INDEXER_DB_USER/PASS) over the published port. Run against the live regtest
 * stack it produced `Access denied for user 'xchain_indexer_bitcoin_regtest'`,
 * i.e. an unknown-state REFUSAL of a perfectly deployable update - the sidecar
 * password and the live account had drifted, which is a documented recurring
 * condition here and has nothing to do with migrations. A guard that fails
 * closed on a routine credential drift blocks every deploy and gets switched
 * off. So this uses the same root-credential runner every other DB read in
 * xchain-node uses (see clearHubPriceIngestWatermark), which the update path
 * already resolves non-interactively for its own credential parity pass.
 */
async function defaultReadAppliedMigrations({ database, coin, network }, deps = {}) {
    // The name comes from getModuleDatabaseName, but it reaches SQL as text (an
    // identifier cannot be bound), so gate it on the same allowlist the
    // provisioning DDL uses rather than trusting its provenance.
    if (!/^[A-Za-z0-9_]+$/.test(String(database))) {
        return { state: 'unreadable', reason: 'refusing to query a database name that is not a plain identifier' }
    }
    const literal = "'" + database + "'"

    let runner = deps.runner
    try {
        if (!runner) {
            const {
                getExternalDbConfig, executeNativeMariaDbCommand,
                executeDockerMariaDbCommand, askMariadbRootPassword, getDatabaseContainerId
            } = require('./DatabaseService')
            if (EXTERNAL_DB) {
                const cfg = await getExternalDbConfig()
                runner = (sql) => executeNativeMariaDbCommand(cfg, sql, '-B -N')
            } else {
                const containerId = await getDatabaseContainerId()
                if (!containerId) return { state: 'unreadable', reason: 'no MariaDB container found on this host' }
                const rootPassword = await askMariadbRootPassword(coin, network)
                runner = (sql) => executeDockerMariaDbCommand(containerId, rootPassword, sql, '-B -N')
            }
        }

        const tableCount = parseInt(String(await runner(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ' + literal)).trim(), 10)
        // No tables at all: either the database does not exist yet or it is
        // untouched. A fresh install builds its schema from src/sql, which already
        // carries the post-migration widths, so it cannot be behind.
        if (!tableCount) return { state: 'empty-database' }

        const hasLedger = parseInt(String(await runner(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ' + literal +
            " AND TABLE_NAME = '" + LEDGER_TABLE + "'")).trim(), 10)
        // Tables but no ledger: this database predates the migration runner, or is
        // not the database we think it is. Either way its migration state is
        // unknowable, which is the case this guard must not wave through.
        if (!hasLedger) {
            return { state: 'unreadable', reason: database + ' holds ' + tableCount + ' table(s) but no ' + LEDGER_TABLE + ' ledger' }
        }

        const out = String(await runner('SELECT name FROM `' + database + '`.' + LEDGER_TABLE))
        const applied = new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
        return { state: 'ledger', applied }
    } catch (err) {
        return { state: 'unreadable', reason: (err && err.message) ? err.message : String(err) }
    }
}

function refusalMessage(module, coin, network, dbName, missing, remedy = {}) {
    const container = getDockerContainerImageName(module, coin, network)
    const files = missing.join(', ')
    const plural = missing.length > 1

    // The remedy runs on the build inside the container, which is the one being
    // REPLACED. Only name the scoped command when that build was confirmed to
    // honour --file; otherwise the command would quietly widen to every pending
    // manual migration, so state that instead of printing it.
    let instructions
    if (remedy.supportsPerFile === true) {
        instructions = 'apply ' + (plural ? 'them' : 'it') +
            ' deliberately, with the writer quiesced, then re-run the update:\n' +
            missing.map(f => '    docker exec -i ' + container + ' node src/migrate.js --file ' + f).join('\n')
    } else {
        const wouldApply = (remedy.pendingManual && remedy.pendingManual.length)
            ? remedy.pendingManual
            : missing
        instructions = 'DO NOT run `node src/migrate.js` inside ' + container + '. ' +
            (remedy.supportsPerFile === false
                ? 'That container runs a build with no per-file targeting: it ignores --file'
                : 'Whether that container\'s build honours --file could not be read, and an unverified capability is not one: it may ignore --file') +
            ' and apply EVERY pending manual migration on ' + dbName + ', which is ' +
            wouldApply.length + ' file(s):\n' +
            wouldApply.map(f => '    ' + f + (missing.includes(f) ? '  (the one you need)' : '')).join('\n') + '\n' +
            '  Apply ' + (plural ? 'the needed files' : 'the needed file') + ' with a build that supports ' +
            '--file, or apply the statement by hand with the writer quiesced, then re-run the update.'
    }

    return 'update refused: the ' + module + ' source about to be deployed asserts migration' +
        (plural ? 's' : '') + ' ' + files + ' at startup, but ' + dbName +
        ' has not applied ' + (plural ? 'them' : 'it') + '. Deploying now replaces a working ' +
        'container with one that crash-loops on boot (the 2026-08-09 mainnet halt: all three indexers went to ' +
        'Restarting(1) on exactly this). These migrations are operator-gated on purpose - ' +
        instructions + '\n' +
        '  Take a fresh backup first: DEPLOY-ORDER.md says so for every migration-bearing deploy, ' +
        'and the coin boxes back up only WEEKLY. ' +
        'Set ' + SKIP_ENV + '=1 to override.'
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
        console.warn(`WARNING: ${SKIP_ENV} is set; skipping the migration precondition check for ${module}. ` +
            'A service whose startup assertion needs an unapplied migration crash-loops as soon as the container is recreated.')
        return { checked: false, reason: 'skipped-by-env' }
    }

    const cloneGitDep  = deps.cloneGit || require('./ModuleService').cloneGit
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
        required = listRequired(path.join(getModuleTmpDir(module), 'src', 'sql', 'migrations'))
    } catch (err) {
        console.warn(`Migration precondition guard: could not read ${module}'s migrations ` +
            `(${err && err.message ? err.message : err}); guard not applied.`)
        return { checked: false, reason: 'source-unreadable' }
    }
    if (!required.length) return { checked: false, reason: 'no-preconditions' }

    const dbName = getModuleDatabaseName(module, coin, network)
    const result = await readApplied({ database: dbName, coin, network })

    if (result.state === 'empty-database') {
        console.warn(`Migration precondition guard: ${dbName} holds no tables yet, so ${module}'s gated ` +
            `migrations (${required.join(', ')}) cannot be outstanding on it; proceeding.`)
        return { checked: true, required, ok: true, reason: 'empty-database' }
    }

    if (result.state !== 'ledger') {
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
            pendingManual   = listPending(path.join(getModuleTmpDir(module), 'src', 'sql', 'migrations'), result.applied)
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
    readAppliedMigrations: defaultReadAppliedMigrations,
    assertRequiredMigrationsApplied
}
