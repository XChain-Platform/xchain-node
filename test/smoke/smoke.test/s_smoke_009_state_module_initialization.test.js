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
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')

describe('S-SMOKE-009 – State Module Initialization', function () {

    const state = proxyquire(path.join(ROOT, 'src/state'), {
        './db': function StubMariaDbStore() {
            this.createDatabase = sinon.stub().resolves()
            this.isReady = sinon.stub().returns(false)
        },
        './services/github_downloader.js': function StubGitHubDownloader() {
            this.loadHashesFile = sinon.stub().returns({})
        }
    })

    it('exports db instance', function () {
        expect(state.db).to.be.an('object')
    })

    it('exports gitHubDownloader instance', function () {
        expect(state.gitHubDownloader).to.be.an('object')
    })

    it('getInstalledModules returns empty object initially', function () {
        expect(state.getInstalledModules()).to.deep.equal({})
    })

    it('getRemoteModuleVersions returns empty object initially', function () {
        expect(state.getRemoteModuleVersions()).to.deep.equal({})
    })

    it('isVerbose returns false initially', function () {
        expect(state.isVerbose()).to.be.false
    })

    it('getDbRootPassword returns null initially', function () {
        expect(state.getDbRootPassword()).to.be.null
    })

    it('setVerbose and isVerbose work as getter/setter', function () {
        state.setVerbose(true)
        expect(state.isVerbose()).to.be.true
        state.setVerbose(false)
        expect(state.isVerbose()).to.be.false
    })

    it('exports all expected getter/setter functions', function () {
        const expectedFns = [
            'getDbRootPassword', 'setDbRootPassword',
            'getInstalledModules', 'setInstalledModules', 'resetInstalledModules',
            'getRemoteModuleVersions', 'setRemoteModuleVersion',
            'isStatusUpdated', 'setStatusUpdated',
            'getLastStatus', 'setLastStatus',
            'getLastPrintedStatus', 'setLastPrintedStatus', 'appendLastPrintedStatus',
            'isVerbose', 'setVerbose'
        ]

        for (const fn of expectedFns) {
            expect(state, `missing export: ${fn}`).to.have.property(fn).that.is.a('function')
        }
    })
})
