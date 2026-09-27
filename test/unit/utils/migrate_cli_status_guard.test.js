'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const sinon      = require('sinon')
const { expect } = require('chai')

const {
    runningBuildSupportsPerFileMigrations
} = require('../../../src/services/migration_precondition_service')

const NEWEST_PATH = 'src/db/migration/migrate.js'
const OLD_PATH    = 'src/migrate.js'
const VALID_STATUS = JSON.stringify({
    database: 'XChain_BTC_Mainnet_Indexer',
    total: 2,
    applied: 1,
    pending: 1,
    migrations: [
        { file: 'a.sql', applied: true, mode: 'auto', appliedAt: '2026-09-24T00:00:00.000Z' },
        { file: 'b.sql', applied: false, mode: 'manual', appliedAt: null }
    ]
})

const FILE_ONLY_SOURCE = `
const args = process.argv.slice(2)
const fileIndex = args.findIndex(arg => arg === '--file' || arg === '-f')
main(fileIndex >= 0 ? args[fileIndex + 1] : null)
`

const STRICT_SOURCE = `
const args = process.argv.slice(2)
for (const arg of args) {
    if (arg === '--file' || arg === '-f' || arg === '--help') continue
    process.exit(2)
}
main()
`

const STATUS_SOURCE = `
const STATUS = '--status'
const JSON_OUTPUT = '--json'
main()
`

function catServing(filePath, source) {
    return sinon.stub().callsFake(async (container, candidate) => {
        if (candidate === filePath) return source
        throw new Error('missing')
    })
}

async function probe(filePath, source, output = VALID_STATUS) {
    const execContainer = sinon.stub().resolves(output)
    const deps = {
        getDockerContainerFileCat: catServing(filePath, source),
        execContainer
    }
    const result = await runningBuildSupportsPerFileMigrations('indexer', deps)
    return { result, execContainer }
}

describe('migrate CLI status contract guard', () => {
    it('does not execute a file-only CLI at the current path', async () => {
        const { result, execContainer } = await probe(NEWEST_PATH, FILE_ONLY_SOURCE)
        expect(result).to.equal(false)
        expect(execContainer.notCalled).to.equal(true)
    })

    it('does not execute a strict CLI without the status contract', async () => {
        const { result, execContainer } = await probe(NEWEST_PATH, STRICT_SOURCE)
        expect(result).to.equal(false)
        expect(execContainer.notCalled).to.equal(true)
    })

    it('does not execute a file-only CLI at the old path', async () => {
        const { result, execContainer } = await probe(OLD_PATH, FILE_ONLY_SOURCE)
        expect(result).to.equal(false)
        expect(execContainer.notCalled).to.equal(true)
    })

    it('executes a CLI that advertises the status contract', async () => {
        const { result, execContainer } = await probe(NEWEST_PATH, STATUS_SOURCE)
        expect(result).to.equal(true)
        expect(execContainer.calledOnceWith(
            'indexer', ['node', NEWEST_PATH, '--status', '--json']
        )).to.equal(true)
    })
})
