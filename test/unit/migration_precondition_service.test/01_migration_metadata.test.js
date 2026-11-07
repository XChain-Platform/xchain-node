'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const fs   = require('fs')
const path = require('path')

// Keep the four migrationMode copies on one fail-safe grammar.
const MODE_TWINS = {
    node:    path.join(__dirname, '../../../src/services/migration_precondition_service/migration_scan.js'),
    indexer: path.join(__dirname, '../../../../xchain-indexer/src/db/database/migration_scan.js'),
    decoder: path.join(__dirname, '../../../../xchain-decoder/src/db/migration_statements.js'),
    hub:     path.join(__dirname, '../../../../xchain-hub/src/db/schema/sql_migration_files.js')
}
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'

// Pull the two token regexes and fail-safe decision out of one copy's source text.
function modeRule(source, file) {
    const header   = source.match(/const header = (\/[^\n]+\/[a-z]+)\.exec\(line\)/)
    const token    = source.match(/matchAll\((\/[^\n]+\/[a-z]+)\)/)
    const decision = source.match(/return (modes\.length > 0 && modes\.every\(mode => mode === 'auto'\) \? 'auto' : 'manual')/)
    if (!header || !token || !decision)
        throw new Error('could not find the migrationMode token rules or decision in ' + file +
            '; re-read that copy and update this parity test rather than skipping it')
    return { header: header[1], token: token[1], decision: decision[1] }
}

function registerMigrationDirectiveTests({ expect, migrationDeclaresDeployPrecondition, TAGGED, UNTAGGED }) {
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
}

function registerMigrationModeTests({ expect, migrationMode, TAGGED }) {
    describe('migrationMode', () => {

        it('reads the mode a header declares', () => {
            expect(migrationMode(TAGGED)).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=auto\nSELECT 1;\n')).to.equal('auto')
        })

        it('defaults to manual when no recognized mode is declared', () => {
            // The runners gate every non-auto file, so an unscoped run applies these too.
            expect(migrationMode('-- just a comment\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration deploy-precondition=required\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=automatic\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=auto2\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=bogus\n-- xchain:migration mode=auto\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=manual (COPY rebuild, not mode=auto)\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=auto mode=manual\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=auto\n-- xchain:migration mode=manual\nSELECT 1;\n')).to.equal('manual')
            expect(migrationMode('-- xchain:migration mode=auto mode=auto\nSELECT 1;\n')).to.equal('auto')
            expect(migrationMode('-- xchain:migration mode=auto\n-- see the mode=manual sibling\nSELECT 1;\n')).to.equal('auto')
        })

        it('ignores a mode token that appears after the prologue', () => {
            // Body prose and data literals must not be able to answer for the file.
            const body = '-- header\nSELECT 1;\n-- xchain:migration mode=auto\n'
            expect(migrationMode(body)).to.equal('manual')
        })

        it('matches the indexer and decoder runners\' rule', function () {
            // The copies are duplicated by necessity; this is what keeps them in step.
            const twins = { indexer: MODE_TWINS.indexer, decoder: MODE_TWINS.decoder, hub: MODE_TWINS.hub }
            const present = Object.entries(twins).filter(([, file]) => fs.existsSync(file))
            if (present.length < 3) {
                if (REQUIRE_SIBLINGS)
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but a runner twin is missing: ' + Object.values(twins).join(', '))
                return this.skip()      // sibling repos not checked out
            }
            const ours = modeRule(fs.readFileSync(MODE_TWINS.node, 'utf8'), MODE_TWINS.node)
            for (const [, file] of present)
                expect(modeRule(fs.readFileSync(file, 'utf8'), file), file).to.deep.equal(ours)
        })
    })
}

function registerMigrationMetadata(deps) {
    registerMigrationDirectiveTests(deps)
    registerMigrationModeTests(deps)
}

module.exports = registerMigrationMetadata
