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

const { XChainService } = require('../../src/config/constants')
const {
    MIGRATION_BEARING_MODULES,
    SKIP_ENV,
    migrationDeclaresDeployPrecondition,
    listDeployPreconditionMigrations,
    readAppliedMigrations,
    assertRequiredMigrationsApplied
} = require('../../src/services/MigrationPreconditionService')

const GATED = '2026-07-24-pubkeys-widen-uncompressed.sql'

const TAGGED   = '-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE pubkeys MODIFY pubkey VARCHAR(130) NOT NULL;\n'
const UNTAGGED = '-- xchain:migration mode=manual\nALTER TABLE pubkeys MODIFY pubkey VARCHAR(130) NOT NULL;\n'

function makeDeps({ required = [GATED], applied = [GATED], state = 'ledger', reason = 'connection refused', cloneErr = null } = {}) {
    return {
        cloneGit: cloneErr ? sinon.stub().rejects(cloneErr) : sinon.stub().resolves(),
        listDeployPreconditionMigrations: sinon.stub().returns(required),
        readAppliedMigrations: sinon.stub().resolves(
            state === 'ledger' ? { state: 'ledger', applied: new Set(applied) } : { state, reason })
    }
}

describe('MigrationPreconditionService', () => {

    let warnStub
    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => {
        warnStub.restore()
        delete process.env[SKIP_ENV]
    })

    describe('migrationDeclaresDeployPrecondition', () => {
        it('reads the tag off the xchain:migration directive line', () => {
            expect(migrationDeclaresDeployPrecondition(TAGGED)).to.equal(true)
        })
        it('tolerates spacing around the token', () => {
            expect(migrationDeclaresDeployPrecondition('--  xchain:migration  mode = manual  deploy-precondition = required\nALTER TABLE t;')).to.equal(true)
        })
        it('is false for an ordinary migration and for an empty file', () => {
            expect(migrationDeclaresDeployPrecondition(UNTAGGED)).to.equal(false)
            expect(migrationDeclaresDeployPrecondition('')).to.equal(false)
        })
        it('ignores the token once the SQL body has started', () => {
            // Prologue anchoring: a migration that merely DISCUSSES the convention in a
            // trailing comment must not start refusing every deploy.
            expect(migrationDeclaresDeployPrecondition('ALTER TABLE t;\n-- xchain:migration mode=manual deploy-precondition=required\n')).to.equal(false)
        })
        it('ignores the token on a comment line that is not the directive', () => {
            expect(migrationDeclaresDeployPrecondition('-- deploy-precondition=required, see the other file\nALTER TABLE t;')).to.equal(false)
        })
        it('sees the tag through a long license banner', () => {
            const banner = Array(30).fill('-- license line').join('\n')
            expect(migrationDeclaresDeployPrecondition(banner + '\n\n' + TAGGED)).to.equal(true)
        })
    })

    describe('listDeployPreconditionMigrations', () => {
        let dir
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-mig-'))
        })
        afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

        it('returns only the tagged .sql files, sorted', () => {
            fs.writeFileSync(path.join(dir, '2026-07-24-b.sql'), TAGGED)
            fs.writeFileSync(path.join(dir, '2026-07-01-a.sql'), TAGGED)
            fs.writeFileSync(path.join(dir, '2026-07-30-c.sql'), UNTAGGED)
            fs.writeFileSync(path.join(dir, 'notes.txt'), TAGGED)
            expect(listDeployPreconditionMigrations(dir)).to.deep.equal(['2026-07-01-a.sql', '2026-07-24-b.sql'])
        })

        it('returns [] for a missing directory (a ref with no migrations declares nothing)', () => {
            expect(listDeployPreconditionMigrations(path.join(dir, 'nope'))).to.deep.equal([])
        })

        it('reads the REAL indexer tree and finds the migration behind the 2026-08-09 halt', function () {
            // Guards the whole contract end to end: if the tag is ever dropped from the
            // committed file, or the migrations path moves, this guard silently stops
            // protecting the deploy that caused the outage. Skipped when xchain-node is
            // checked out on its own, without the sibling indexer tree beside it.
            const indexerMigrations = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql', 'migrations')
            if (!fs.existsSync(indexerMigrations)) return this.skip()
            expect(listDeployPreconditionMigrations(indexerMigrations)).to.include(GATED)
        })
    })

    describe('readAppliedMigrations', () => {

        const target = { database: 'XChain_BTC_Mainnet_Indexer', coin: 'bitcoin', network: 'mainnet' }

        // Fake mariadb batch-mode output: one value per COUNT query, newline-joined
        // names for the ledger read - the exact shapes `-B -N` produces.
        function runnerFor({ tables = 40, ledger = 1, names = [GATED] }) {
            return async (sql) => {
                if (/TABLE_NAME = 'schema_migrations'/.test(sql)) return String(ledger)
                if (/COUNT\(\*\)/.test(sql)) return String(tables)
                return names.join('\n')
            }
        }

        it('reads the ledger into a set of applied names', async () => {
            const res = await readAppliedMigrations(target, { runner: runnerFor({ names: [GATED, '2026-08-11-attests-relay-identity-index.sql'] }) })
            expect(res.state).to.equal('ledger')
            expect([...res.applied]).to.have.members([GATED, '2026-08-11-attests-relay-identity-index.sql'])
        })

        it('tolerates a ledger read that comes back empty', async () => {
            const res = await readAppliedMigrations(target, { runner: runnerFor({ names: [] }) })
            expect(res.state).to.equal('ledger')
            expect(res.applied.size).to.equal(0)
        })

        it('calls a database with no tables empty, not unreadable', async () => {
            const res = await readAppliedMigrations(target, { runner: runnerFor({ tables: 0 }) })
            expect(res.state).to.equal('empty-database')
        })

        it('calls a populated database with no ledger table UNREADABLE, never empty', async () => {
            // Waving this through would be the whole outage again: a real schema whose
            // migration state nobody can see.
            const res = await readAppliedMigrations(target, { runner: runnerFor({ tables: 40, ledger: 0 }) })
            expect(res.state).to.equal('unreadable')
            expect(res.reason).to.contain('schema_migrations')
        })

        it('turns a driver failure into unreadable instead of throwing past the guard', async () => {
            // A throw here would escape assertRequiredMigrationsApplied as an opaque
            // driver error, and the operator would read ECONNREFUSED with no idea a
            // migration was at stake.
            const res = await readAppliedMigrations(target, {
                runner: async () => { throw new Error('ECONNREFUSED 127.0.0.1:13306') }
            })
            expect(res.state).to.equal('unreadable')
            expect(res.reason).to.contain('ECONNREFUSED')
        })

        it('refuses a database name that is not a plain identifier, before any query runs', async () => {
            let called = false
            const res = await readAppliedMigrations(
                { database: 'x`; DROP DATABASE y; -- ', coin: 'bitcoin', network: 'mainnet' },
                { runner: async () => { called = true; return '0' } })
            expect(res.state).to.equal('unreadable')
            expect(called, 'nothing may reach SQL').to.equal(false)
        })
    })

    describe('assertRequiredMigrationsApplied', () => {

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

        it('refuses when the target DB has not applied a declared precondition', async () => {
            const deps = makeDeps({ applied: ['2026-07-21-anchor-reward-attestations-table.sql'] })
            let err = null
            try {
                await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
            } catch (e) { err = e }
            expect(err, 'the deploy must be refused').to.not.equal(null)
            expect(err.message).to.contain(GATED)
            expect(err.message).to.contain('XChain_BTC_Mainnet_Indexer')
            expect(err.message).to.contain('--file ' + GATED)
        })

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
    })
})
