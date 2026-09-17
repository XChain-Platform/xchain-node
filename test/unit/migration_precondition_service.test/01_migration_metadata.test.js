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

        it('returns null when no mode is declared', () => {
            expect(migrationMode('-- just a comment\nSELECT 1;\n')).to.equal(null)
        })

        it('ignores a mode token that appears after the prologue', () => {
            // Body prose and data literals must not be able to answer for the file.
            const body = '-- header\nSELECT 1;\n-- xchain:migration mode=auto\n'
            expect(migrationMode(body)).to.equal(null)
        })
    })
}

function registerMigrationMetadata(deps) {
    registerMigrationDirectiveTests(deps)
    registerMigrationModeTests(deps)
}

module.exports = registerMigrationMetadata
