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

const sinon      = require('sinon')
const { expect } = require('chai')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] State & Data Integrity', function () {

        // Store-level regressions (R-STA-001..003b) live in test/unit/maria_db_store.test.js
        // since the persistence layer moved from LevelDB to MariaDB.

        it('R-STA-004: state singleton getters/setters round-trip correctly', function () {
            const {
                getDbRootPassword, setDbRootPassword,
                getInstalledModules, setInstalledModules, resetInstalledModules,
                isStatusUpdated, setStatusUpdated,
                getLastStatus, setLastStatus,
                isVerbose, setVerbose
            } = require('../../../src/state')

            // dbRootPassword
            setDbRootPassword('secret')
            expect(getDbRootPassword()).to.equal('secret')
            setDbRootPassword(null)
            expect(getDbRootPassword()).to.be.null

            // installedModules
            const mods = { bitcoin: { mainnet: {} } }
            setInstalledModules(mods)
            expect(getInstalledModules()).to.deep.equal(mods)
            resetInstalledModules()
            expect(getInstalledModules()).to.deep.equal({})

            // statusUpdated
            setStatusUpdated(true)
            expect(isStatusUpdated()).to.be.true
            setStatusUpdated(false)

            // lastStatus
            setLastStatus({ test: true })
            expect(getLastStatus()).to.deep.equal({ test: true })
            setLastStatus(null)

            // verbose
            setVerbose(true)
            expect(isVerbose()).to.be.true
            setVerbose(false)
        })

        // R-STA-005 (re-insert overwrite) and R-STA-006 (independence across
        // coin/network combos) are now covered in test/unit/MariaDbStore.test.js.
    })
})
