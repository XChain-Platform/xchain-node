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
const { proxyquireDockerService } = require('../../../helpers/docker_service_loader')
const { Readable } = require('stream')

const { moduleDir, tmpDir } = require('../../../../src/config')

function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

function makeConfigService(fsStub) {
    return proxyquire('../../../../src/services/config_service', {
        'fs': fsStub || require('fs')
    })
}

function makeServiceWithConfig(configContent) {
    const fsStub = {
        createReadStream: sinon.stub().callsFake(() => streamFromString(configContent)),
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().returns(''),
        appendFileSync: sinon.stub(),
        writeFileSync: sinon.stub(),
        rmSync: sinon.stub(),
        mkdirSync: sinon.stub(),
        chmodSync: sinon.stub()
    }
    return makeConfigService(fsStub)
}

function loadDockerService(stubs) {
    return proxyquireDockerService(require.resolve('../../../../src/services/docker_service'), {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn || sinon.stub(),
            spawnSync: stubs.spawnSync || sinon.stub()
        },
        'util': { promisify: (fn) => fn },
        'fs': stubs.fs || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

function loadModuleService(stubs, configOverrides) {
    const configServiceStub = Object.assign({
        getModuleDir: (m) => moduleDir + '/' + m,
        getModuleTmpDir: (m) => tmpDir + '/' + m,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (m, c, n) => `xchain-node-${c}-${n}-${m}`,
        getDockerNetwork: (c, n) => 'xchain-node' + (c ? '-' + c : '') + (n ? '-' + n : ''),
        validatePort: (v) => {
            if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535
            if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 }
            return false
        },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'bitcoin-mainnet',
            'DECODER_PORT': 3002,
            'DECODER_API_PORT': 3002
        })
    }, configOverrides || {})

    return proxyquire('../../../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
        '../state': {
            db: stubs.db || { setModuleContainer: sinon.stub().resolves(true) },
            getLastStatus: () => null,
            getRemoteModuleVersions: () => ({})
        },
        './config_service': configServiceStub,
        './status_service': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './docker_service': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), getStatusFromContainer: sinon.stub().resolves({}) },
        './database_service': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

module.exports = { makeConfigService, makeServiceWithConfig, loadDockerService, loadModuleService }
