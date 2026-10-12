'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The refusal's remedy runs inside the container being REPLACED, so the files it
// names come from that build's own --status rows: a precondition first shipping
// in the release being deployed is not something that build can apply, and its
// migrate CLI rejects a --file it does not carry.

const sinon = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../../src/config')
const {
    assertRequiredMigrationsApplied, readRunningBuildMigrationStatus
} = require('../../../src/services/migration_precondition_service')

const NEW_FILE = '2026-09-30-list-share-tables.sql'
const OLD_FILE = '2026-09-12-bridge-tables.sql'
const STATUS_SOURCE = "const STATUS = '--status'\nmain()\n"

function depsFor({ required, rows, supportsPerFile = true, targetPending = [] }) {
    return {
        cloneGit: sinon.stub().resolves(),
        listDeployPreconditionMigrations: sinon.stub().returns(required),
        readAppliedMigrations: sinon.stub().resolves({ state: 'ledger', applied: new Set(['2026-05-30-balances-composite-index.sql']) }),
        readRunningBuildMigrationStatus: sinon.stub().resolves({ supportsPerFile, rows }),
        pendingManualMigrations: sinon.stub().returns(targetPending)
    }
}
async function refusal(deps) {
    try {
        await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
    } catch (err) {
        return err.message
    }
    throw new Error('the deploy must be refused')
}

describe('migration precondition refusal: the running build decides the remedy', () => {
    beforeEach(() => { sinon.stub(console, 'warn') })
    afterEach(() => { sinon.restore() })

    it('prints no --file for a missing file the running build does not carry, and names the hand-apply route', async () => {
        const message = await refusal(depsFor({
            required: [NEW_FILE],
            rows: [{ file: '2026-05-30-balances-composite-index.sql', applied: true, mode: 'manual' }]
        }))
        expect(message).to.not.contain('--file ' + NEW_FILE)
        expect(message).to.contain('does not carry ' + NEW_FILE)
        expect(message).to.match(/from the release being deployed by hand/)
        expect(message).to.contain('XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION=1')
    })

    it('prints --file only for the missing file the running build carries', async () => {
        const message = await refusal(depsFor({
            required: [OLD_FILE, NEW_FILE],
            rows: [{ file: OLD_FILE, applied: false, mode: 'manual' }]
        }))
        expect(message).to.contain('--file ' + OLD_FILE)
        expect(message).to.not.contain('--file ' + NEW_FILE)
        expect(message).to.contain('does not carry ' + NEW_FILE)
    })

    it('labels a blast radius it could only read from the source being deployed', async () => {
        const message = await refusal(depsFor({
            required: [OLD_FILE], rows: null, supportsPerFile: null, targetPending: [OLD_FILE]
        }))
        expect(message).to.contain('DO NOT run')
        expect(message).to.contain('listed from the source being deployed')
        expect(message).to.contain(OLD_FILE + '  (the one you need)')
    })
})

describe('readRunningBuildMigrationStatus()', () => {
    it("keeps a valid status response's rows, so the refusal can read that build's file list", async () => {
        const status = {
            database: 'XChain_BTC_Mainnet_Indexer', total: 2, applied: 1, pending: 1,
            migrations: [
                { file: 'a.sql', applied: true, mode: 'auto', appliedAt: '2026-09-24T00:00:00.000Z' },
                { file: 'b.sql', applied: false, mode: 'manual', appliedAt: null }
            ]
        }
        const result = await readRunningBuildMigrationStatus('indexer', {
            getDockerContainerFileCat: sinon.stub().callsFake(async (c, p) => {
                if (p === 'src/db/migration/migrate.js') return STATUS_SOURCE
                throw new Error('missing')
            }),
            execContainer: sinon.stub().resolves(JSON.stringify(status))
        })
        expect(result.supportsPerFile).to.equal(true)
        expect(result.rows).to.deep.equal([
            { file: 'a.sql', applied: true, mode: 'auto' },
            { file: 'b.sql', applied: false, mode: 'manual' }
        ])
    })

    it('keeps no rows from a response that fails the contract', async () => {
        const result = await readRunningBuildMigrationStatus('indexer', {
            getDockerContainerFileCat: sinon.stub().resolves(STATUS_SOURCE),
            execContainer: sinon.stub().resolves('{"database":"x","migrations":[{"file":"a.sql"}]}')
        })
        expect(result).to.deep.equal({ supportsPerFile: false, rows: null })
    })
})
