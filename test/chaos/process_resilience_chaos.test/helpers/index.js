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
const proxyquire = require('proxyquire').noCallThru()

// Helpers
function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        }
    }
}

function loadModuleService(stubs, opts = {}) {
    return proxyquire('../../../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        },
        '../state': {
            db: opts.db || {
                setModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                deleteModuleContainer: sinon.stub().resolves(true)
            },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './config_service': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: (mod, coin, net) => {
                if (['database', 'xchain-hub', 'xchain-explorer', 'xchain-sync'].includes(mod)) {
                    return 'xchain-node-' + mod
                }
                return 'xchain-node-' + coin + '-' + net + '-' + mod
            },
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
            validatePort: () => true,
            getDefaultConfig: sinon.stub().resolves({
                'NETWORK': 'bitcoin-regtest',
                'NODE_PORT': 18444,
                'ENCODER_PORT': 3003,
                'ENCODER_API_PORT': 3003
            })
        },
        './status_service': {
            statusChanged: opts.statusChanged || sinon.stub().resolves(),
            getStatus: sinon.stub().resolves({})
        },
        './docker_service': {
            killContainer: opts.killContainer || sinon.stub().resolves(true),
            removeContainer: opts.removeContainer || sinon.stub().resolves(true),
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
        },
        './database_service': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

module.exports = { makeStubs, loadModuleService }
