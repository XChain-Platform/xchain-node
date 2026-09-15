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
const { makeStubs, loadModuleService } = require('./helpers')

describe('Chaos: Process Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

describe('Experiment: Multi-step operation error propagation', function () {

        it('module not found error before any docker operations', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

        const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: { setModuleContainer: sinon.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(false), // Module not found
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: () => 'test',
                    getDockerNetwork: () => 'test',
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
                './docker_service': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
                './database_service': { setDatabaseParameters: sinon.stub().resolves() }
            })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.equal('module not found')
            }

            // No docker commands should have been called
            expect(stubs.execFile.called).to.be.false
        })
    })
})
