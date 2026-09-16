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
const { configStub } = require('../../helpers/config_stub')
const proxyquire = require('proxyquire').noCallThru()

describe('Chaos: Process Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

describe('Experiment: Precheck failure cascade', function () {

        it('Directory creation failure does not throw (mkdirSync creates dirs)', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                mkdirSync: sinon.stub()
            }

        const precheck = proxyquire('../../../src/precheck', {
                './config': configStub({
                    dataDir: '/tmp/test-data',
                    moduleDir: '/tmp/test-modules',
                    tmpDir: '/tmp/test-tmp',
                    containersFilesDir: '/tmp/test-containers'
                }),
                './state': { db: { createDatabase: sinon.stub() }, isVerbose: () => false },
                './services/docker_service': {
                    checkDockerInstalledAndReachable: sinon.stub(),
                    createDockerNetwork: sinon.stub()
                },
                './services/config_service': { getDockerNetwork: () => 'xchain-node' },
                './services/version_service': { checkAllRemoteVersions: sinon.stub() },
                './services/status_service': { getStatus: sinon.stub() },
                './services/hub_service': { installHubModule: sinon.stub(), updateHub: sinon.stub() },
                './services/explorer_service': { updateExplorer: sinon.stub() },
                'fs': fsStub
            })

            precheck.createDirectories()
            expect(fsStub.mkdirSync.callCount).to.equal(4)
        })
    })
})
