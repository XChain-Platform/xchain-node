'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Where the indexer's operator migration CLI is read from inside a container.
// The deploy guard reads the container being REPLACED, which can run an indexer
// build from either layout (top of src/ or the v0.19.0+ src/db/migration/), so
// the probe has to answer for both and the refusal has to print the path that
// running build really carries.

const sinon      = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../../src/config')
const { MIGRATE_CLI_PATHS, readMigrateCli, migrateCliPathFor } = require('../../../src/utils/indexer_migrate_cli')
const {
    runningBuildSupportsPerFileMigrations,
    assertRequiredMigrationsApplied
} = require('../../../src/services/migration_precondition_service')

const GATED        = '2026-07-24-pubkeys-widen-uncompressed.sql'
const NEWEST_PATH  = 'src/db/migration/migrate.js'
const OLD_PATH     = 'src/migrate.js'

const CLI_SOURCE = 'main()'
const VALID_STATUS = JSON.stringify({
    database: 'XChain_BTC_Mainnet_Indexer',
    total: 2,
    applied: 1,
    pending: 1,
    migrations: [
        { file: 'a.sql', applied: true, mode: 'auto', appliedAt: '2026-09-24T00:00:00.000Z' },
        { file: GATED, applied: false, mode: 'manual', appliedAt: null }
    ]
})

// A stand-in for `docker exec <c> cat <path>`: it answers only at the paths
// the fake build carries and rejects elsewhere, the way cat exits non-zero on
// a missing file.
function catFor(files) {
    return sinon.spy(async (container, filePath) => {
        if (Object.prototype.hasOwnProperty.call(files, filePath)) return files[filePath]
        throw new Error('cat: ' + filePath + ': No such file or directory')
    })
}

function execReturning(output) {
    return sinon.stub().resolves(output)
}

function registerPathPrecedenceTests() {
    // Pins the full candidate list, newest first, so a future indexer layout
    // move that edits MIGRATE_CLI_PATHS without adding the new path (or drops
    // an old one a still-supported build carries) fails here first, rather
    // than silently reappearing as the 'could not be read' refusal on the
    // next roll.
    it('pins every known CLI layout, newest first', () => {
        expect(MIGRATE_CLI_PATHS).to.deep.equal([NEWEST_PATH, OLD_PATH])
    })

    describe('readMigrateCli', () => {
        it('reads the v0.19.0+ db/migration layout before the older path', async () => {
            const cat = catFor({ [NEWEST_PATH]: CLI_SOURCE, [OLD_PATH]: CLI_SOURCE })
            const found = await readMigrateCli(cat, 'c-newest')
            expect(found).to.deep.equal({ cliPath: NEWEST_PATH, source: CLI_SOURCE })
            expect(cat.firstCall.args[1]).to.equal(NEWEST_PATH)
            expect(migrateCliPathFor('c-newest')).to.equal(NEWEST_PATH)
        })

        it('falls back to the pre-move path on a build that still carries it', async () => {
            const found = await readMigrateCli(catFor({ [OLD_PATH]: CLI_SOURCE }), 'c-old')
            expect(found).to.deep.equal({ cliPath: OLD_PATH, source: CLI_SOURCE })
            expect(migrateCliPathFor('c-old')).to.equal(OLD_PATH)
        })

        it('counts an empty read as absent, as the single-path probe did', async () => {
            const found = await readMigrateCli(catFor({ [NEWEST_PATH]: '', [OLD_PATH]: CLI_SOURCE }), 'c-empty')
            expect(found.cliPath).to.equal(OLD_PATH)
        })

        it('answers null and forgets what it found before when no known path answers', async () => {
            await readMigrateCli(catFor({ [OLD_PATH]: CLI_SOURCE }), 'c-gone')
            expect(await readMigrateCli(catFor({}), 'c-gone')).to.equal(null)
            expect(migrateCliPathFor('c-gone')).to.equal(MIGRATE_CLI_PATHS[0])
        })
    })
}

function registerCapabilityDetectionTests() {
    describe('runningBuildSupportsPerFileMigrations', () => {
        it('accepts a valid status response from a build before the path move', async () => {
            const execContainer = execReturning(VALID_STATUS)
            const deps = { getDockerContainerFileCat: catFor({ [OLD_PATH]: CLI_SOURCE }), execContainer }
            expect(await runningBuildSupportsPerFileMigrations('c-probe-old', deps)).to.equal(true)
            expect(execContainer.calledOnceWith('c-probe-old', ['node', OLD_PATH, '--status', '--json'])).to.equal(true)
        })

        it('accepts a valid status response from a build after the path move', async () => {
            const execContainer = execReturning(VALID_STATUS)
            const deps = { getDockerContainerFileCat: catFor({ [NEWEST_PATH]: CLI_SOURCE }), execContainer }
            expect(await runningBuildSupportsPerFileMigrations('c-probe-new', deps)).to.equal(true)
            expect(execContainer.calledOnceWith('c-probe-new', ['node', NEWEST_PATH, '--status', '--json'])).to.equal(true)
        })

        it('rejects malformed status JSON', async () => {
            const deps = {
                getDockerContainerFileCat: catFor({ [OLD_PATH]: CLI_SOURCE }),
                execContainer: execReturning('{"database":')
            }
            expect(await runningBuildSupportsPerFileMigrations('c-probe-malformed', deps)).to.equal(false)
        })

        it('reports a CLI without --status support as lacking the capability', async () => {
            const deps = {
                getDockerContainerFileCat: catFor({ [OLD_PATH]: CLI_SOURCE }),
                execContainer: sinon.stub().rejects(new Error('unrecognized argument "--status"'))
            }
            expect(await runningBuildSupportsPerFileMigrations('c-probe-no-status', deps)).to.equal(false)
        })

        it('answers null for a container with no CLI at any known path', async () => {
            const execContainer = execReturning(VALID_STATUS)
            const deps = { getDockerContainerFileCat: catFor({}), execContainer }
            expect(await runningBuildSupportsPerFileMigrations('c-probe-none', deps)).to.equal(null)
            expect(execContainer.called).to.equal(false)
        })
    })
}

function registerRefusalBehaviorTests() {
    describe('refusal remedy', () => {
        let warnStub
        beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
        afterEach(() => { warnStub.restore() })

        // The real probe runs here (no runningBuildSupportsPerFileMigrations stub),
        // so the printed command comes from what the fake container carries.
        async function refusalFor(files, execContainer = execReturning(VALID_STATUS)) {
            const deps = {
                cloneGit: sinon.stub().resolves(),
                listDeployPreconditionMigrations: sinon.stub().returns([GATED]),
                readAppliedMigrations: sinon.stub().resolves({ state: 'ledger', applied: new Set() }),
                pendingManualMigrations: sinon.stub().returns([GATED]),
                getDockerContainerFileCat: catFor(files),
                execContainer
            }
            try {
                await assertRequiredMigrationsApplied(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet', 'master', deps)
            } catch (e) {
                return e.message
            }
            return null
        }

        it('names the pre-move CLI path when the running build carries only that', async () => {
            const message = await refusalFor({ [OLD_PATH]: CLI_SOURCE })
            expect(message, 'the deploy must be refused').to.not.equal(null)
            expect(message).to.contain('node ' + OLD_PATH + ' --file ' + GATED)
        })

        it('names the v0.19.0+ db/migration CLI path when the running build carries that', async () => {
            const message = await refusalFor({ [NEWEST_PATH]: CLI_SOURCE })
            expect(message, 'the deploy must be refused').to.not.equal(null)
            expect(message).to.contain('node ' + NEWEST_PATH + ' --file ' + GATED)
            expect(message).to.not.contain('node ' + OLD_PATH)
        })

        it('keeps the refusal and omits a scoped command when the CLI rejects --status', async () => {
            const execContainer = sinon.stub().rejects(new Error('unrecognized argument "--status"'))
            const message = await refusalFor({ [OLD_PATH]: CLI_SOURCE }, execContainer)
            expect(message, 'the deploy must be refused').to.not.equal(null)
            expect(message).to.contain('did not return a valid --status --json response')
            expect(message).to.not.contain('docker exec')
        })

        it('still refuses, naming the newest layout as the remedy, when the container answers at none of the known paths', async () => {
            const message = await refusalFor({})
            expect(message, 'the deploy must be refused').to.not.equal(null)
            expect(message).to.contain('could not be read')
            expect(message).to.contain('node ' + NEWEST_PATH)
        })
    })
}

describe('indexer migrate CLI location', () => {
    registerPathPrecedenceTests()
    registerCapabilityDetectionTests()
    registerRefusalBehaviorTests()
})
