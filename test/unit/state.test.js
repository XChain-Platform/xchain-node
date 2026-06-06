'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai')

describe('state', function () {

    // We need a fresh copy of state for each test to avoid cross-test pollution.
    // state.js instantiates singletons (db, gitHubDownloader) that require disk access.
    // We only test the getter/setter functions, not the singletons.

    const {
        getDbRootPassword, setDbRootPassword,
        getInstalledModules, setInstalledModules, resetInstalledModules,
        getRemoteModuleVersions, setRemoteModuleVersion,
        isStatusUpdated, setStatusUpdated,
        getLastStatus, setLastStatus,
        getLastPrintedStatus, setLastPrintedStatus, appendLastPrintedStatus,
        isVerbose, setVerbose
    } = require('../../src/state')

    afterEach(function () {
        // Reset to defaults
        setDbRootPassword(null)
        resetInstalledModules()
        setStatusUpdated(false)
        setLastStatus(null)
        setLastPrintedStatus('')
        setVerbose(false)
    })

    describe('dbRootPassword', function () {
        it('defaults to null', function () {
            expect(getDbRootPassword()).to.be.null
        })

        it('round-trips a password', function () {
            setDbRootPassword('secret123')
            expect(getDbRootPassword()).to.equal('secret123')
        })

        it('can be reset to null', function () {
            setDbRootPassword('secret')
            setDbRootPassword(null)
            expect(getDbRootPassword()).to.be.null
        })
    })

    describe('installedModules', function () {
        it('defaults to empty object', function () {
            resetInstalledModules()
            expect(getInstalledModules()).to.deep.equal({})
        })

        it('round-trips a nested object', function () {
            const modules = { bitcoin: { mainnet: { encoder: { container_id: 'abc' } } } }
            setInstalledModules(modules)
            expect(getInstalledModules()).to.deep.equal(modules)
        })

        it('resetInstalledModules clears to empty object', function () {
            setInstalledModules({ something: true })
            resetInstalledModules()
            expect(getInstalledModules()).to.deep.equal({})
        })
    })

    describe('remoteModuleVersions', function () {
        it('can set and retrieve individual versions', function () {
            setRemoteModuleVersion('xchain-encoder', '1.0.0')
            expect(getRemoteModuleVersions()['xchain-encoder']).to.equal('1.0.0')
        })

        it('preserves previous versions when adding new ones', function () {
            setRemoteModuleVersion('xchain-encoder', '1.0.0')
            setRemoteModuleVersion('xchain-decoder', '2.0.0')
            const versions = getRemoteModuleVersions()
            expect(versions['xchain-encoder']).to.equal('1.0.0')
            expect(versions['xchain-decoder']).to.equal('2.0.0')
        })
    })

    describe('statusUpdated', function () {
        it('defaults to false', function () {
            expect(isStatusUpdated()).to.be.false
        })

        it('can be set to true', function () {
            setStatusUpdated(true)
            expect(isStatusUpdated()).to.be.true
        })
    })

    describe('lastStatus', function () {
        it('defaults to null', function () {
            expect(getLastStatus()).to.be.null
        })

        it('round-trips an object', function () {
            const status = { bitcoin: { mainnet: {} } }
            setLastStatus(status)
            expect(getLastStatus()).to.deep.equal(status)
        })
    })

    describe('lastPrintedStatus', function () {
        it('defaults to empty string after reset', function () {
            setLastPrintedStatus('')
            expect(getLastPrintedStatus()).to.equal('')
        })

        it('round-trips a string', function () {
            setLastPrintedStatus('STATUS TABLE')
            expect(getLastPrintedStatus()).to.equal('STATUS TABLE')
        })

        it('appendLastPrintedStatus concatenates', function () {
            setLastPrintedStatus('line1\n')
            appendLastPrintedStatus('line2\n')
            expect(getLastPrintedStatus()).to.equal('line1\nline2\n')
        })
    })

    describe('verbose', function () {
        it('defaults to false', function () {
            expect(isVerbose()).to.be.false
        })

        it('can be set to true', function () {
            setVerbose(true)
            expect(isVerbose()).to.be.true
        })
    })
})
