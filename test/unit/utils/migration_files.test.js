'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The deploy-precondition guard reads migrations out of a cloned module tree
// whose layout depends on the ref: flat src/sql/migrations/ for the decoder and
// for indexer refs cut before the SQL home moved, bucketed src/db/sql/migrations/
// after. A reader that assumes one layout reads an empty directory on the other
// and waves a gated deploy through, so both layouts are pinned here.

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const { expect } = require('chai')

const { migrationsDirOf, migrationFiles } = require('../../../src/utils/migration_files')
const {
    listDeployPreconditionMigrations,
    pendingManualMigrations
} = require('../../../src/services/migration_precondition_service')

const TAGGED = '-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE t ADD COLUMN c INT;\n'
const AUTO   = '-- xchain:migration mode=auto\nSELECT 1;\n'

function write(root, rel, body) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
}

describe('migration_files', () => {
    let root
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-layout-')) })
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

    describe('migrationsDirOf', () => {
        it('reads the moved home when the tree carries it', () => {
            write(root, 'src/db/sql/migrations/2026-05-30/2026-05-30-a.sql', AUTO)
            write(root, 'src/sql/migrations/2026-05-30-a.sql', AUTO)
            expect(migrationsDirOf(root)).to.equal(path.join(root, 'src', 'db', 'sql', 'migrations'))
        })

        it('falls back to the flat home for a tree cut before the move, or the decoder', () => {
            write(root, 'src/sql/migrations/2026-05-30-a.sql', AUTO)
            expect(migrationsDirOf(root)).to.equal(path.join(root, 'src', 'sql', 'migrations'))
        })

        it('names the flat home even when neither exists, so the caller sees a missing directory', () => {
            expect(migrationsDirOf(root)).to.equal(path.join(root, 'src', 'sql', 'migrations'))
        })
    })
})

describe('migration_files', () => {
    let root
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-layout-')) })
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

    describe('migrationFiles', () => {
        it('lists a flat directory by basename, .sql only', () => {
            write(root, 'm/2026-07-02-b.sql', AUTO)
            write(root, 'm/2026-07-01-a.sql', AUTO)
            write(root, 'm/notes.txt', AUTO)
            expect(migrationFiles(path.join(root, 'm')).map(([n]) => n)).to.deep.equal(['2026-07-01-a.sql', '2026-07-02-b.sql'])
        })

        it('orders bucketed files by BASENAME, not by the path a bucket gives them', () => {
            // The bucket names sort opposite to the files, so a path sort and a
            // basename sort disagree; the runner applies by basename.
            write(root, 'm/z-bucket/2026-01-01-first.sql', AUTO)
            write(root, 'm/a-bucket/2026-02-01-second.sql', AUTO)
            const listed = migrationFiles(path.join(root, 'm'))
            expect(listed.map(([n]) => n)).to.deep.equal(['2026-01-01-first.sql', '2026-02-01-second.sql'])
            expect(listed[0][1]).to.equal(path.join(root, 'm', 'z-bucket', '2026-01-01-first.sql'))
        })

        it('yields [] for a missing directory', () => {
            expect(migrationFiles(path.join(root, 'nope'))).to.deep.equal([])
        })
    })
})

describe('migration_files', () => {
    let root
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-layout-')) })
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

    describe('the guard over a bucketed tree', () => {
        it('finds a deploy-precondition migration inside a bucket', () => {
            write(root, 'src/db/sql/migrations/2026-07-26/2026-07-30-gated.sql', TAGGED)
            write(root, 'src/db/sql/migrations/2026-05-30/2026-05-30-plain.sql', AUTO)
            expect(listDeployPreconditionMigrations(migrationsDirOf(root))).to.deep.equal(['2026-07-30-gated.sql'])
        })

        it('names pending manual migrations by basename across buckets', () => {
            write(root, 'src/db/sql/migrations/2026-07-26/2026-07-30-gated.sql', TAGGED)
            write(root, 'src/db/sql/migrations/2026-05-30/2026-05-31-other.sql', TAGGED)
            const dir = migrationsDirOf(root)
            expect(pendingManualMigrations(dir, new Set())).to.deep.equal(['2026-05-31-other.sql', '2026-07-30-gated.sql'])
            expect(pendingManualMigrations(dir, new Set(['2026-05-31-other.sql']))).to.deep.equal(['2026-07-30-gated.sql'])
        })
    })
})
