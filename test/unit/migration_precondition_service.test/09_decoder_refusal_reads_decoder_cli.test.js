'use strict'

// Copyright © 2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The guard refuses decoder deploys too, and the decoder's CLI sits at
// src/db/migrate.js and answers --status --json with name lists. A refusal that
// only knew the indexer layout named a path the decoder container lacks and
// never offered the scoped --file command the decoder build supports.

const sinon = require('sinon')
const { expect } = require('chai')

const { XChainService } = require('../../../src/config')
const {
    assertRequiredMigrationsApplied, readRunningBuildMigrationStatus
} = require('../../../src/services/migration_precondition_service')

const DECODER_CLI = 'src/db/migrate.js'
const GATED_FILE = '2026-08-10-action-data-utf8mb4.sql'
const DECODER_SOURCE = "if (a === '--status') {}\nif (a === '--file' || a === '-f') {}\n"

function catServing(filePath, source) {
    return sinon.stub().callsFake(async (container, candidate) => {
        if (candidate === filePath) return source
        throw new Error('missing')
    })
}

function decoderDeps(statusJson, source = DECODER_SOURCE) {
    return {
        getDockerContainerFileCat: catServing(DECODER_CLI, source),
        execContainer: sinon.stub().resolves(statusJson)
    }
}

const STATUS = JSON.stringify({ applied: ['2026-06-02-widen-ids-to-bigint.sql'], pending: [GATED_FILE] })

describe('migration precondition refusal: a decoder deploy reads the decoder CLI', () => {
    beforeEach(() => { sinon.stub(console, 'warn') })
    afterEach(() => { sinon.restore() })

    it("reads the decoder build's status rows at the decoder CLI path", async () => {
        const deps = decoderDeps(STATUS)
        const result = await readRunningBuildMigrationStatus('decoder-c1', deps, XChainService.XCHAIN_DECODER)
        expect(result).to.deep.equal({
            supportsPerFile: true,
            rows: [
                { file: '2026-06-02-widen-ids-to-bigint.sql', applied: true },
                { file: GATED_FILE, applied: false }
            ]
        })
        expect(deps.execContainer.firstCall.args[1]).to.deep.equal(['node', DECODER_CLI, '--status', '--json'])
    })

    it('refuses a decoder status that lists one file as both applied and pending', async () => {
        const deps = decoderDeps(JSON.stringify({ applied: [GATED_FILE], pending: [GATED_FILE] }))
        const result = await readRunningBuildMigrationStatus('decoder-c2', deps, XChainService.XCHAIN_DECODER)
        expect(result).to.deep.equal({ supportsPerFile: false, rows: null })
    })

    it('refuses a decoder status when the CLI source shows no --file', async () => {
        const deps = decoderDeps(STATUS, "if (a === '--status') {}\n")
        const result = await readRunningBuildMigrationStatus('decoder-c3', deps, XChainService.XCHAIN_DECODER)
        expect(result).to.deep.equal({ supportsPerFile: false, rows: null })
    })

    it('keeps the name-list shape off an indexer read', async () => {
        const deps = {
            getDockerContainerFileCat: catServing('src/db/migration/migrate.js', DECODER_SOURCE),
            execContainer: sinon.stub().resolves(STATUS)
        }
        const result = await readRunningBuildMigrationStatus('indexer-c4', deps, XChainService.XCHAIN_INDEXER)
        expect(result).to.deep.equal({ supportsPerFile: false, rows: null })
    })

    it('names the decoder CLI and its scoped --file command in a decoder refusal', async () => {
        const deps = {
            ...decoderDeps(STATUS),
            cloneGit: sinon.stub().resolves(),
            listDeployPreconditionMigrations: sinon.stub().returns([GATED_FILE]),
            readAppliedMigrations: sinon.stub().resolves({ state: 'ledger', applied: new Set(['2026-06-02-widen-ids-to-bigint.sql']) }),
            pendingManualMigrations: sinon.stub().returns([])
        }
        let message = null
        try {
            await assertRequiredMigrationsApplied(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet', 'master', deps)
        } catch (err) {
            message = err.message
        }
        expect(message, 'the deploy must be refused').to.be.a('string')
        expect(message).to.contain('node ' + DECODER_CLI + ' --file ' + GATED_FILE)
        expect(message).to.not.contain('src/db/migration/migrate.js')
        expect(message).to.not.contain('DO NOT run')
    })
})
