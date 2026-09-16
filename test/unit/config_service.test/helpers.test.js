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
const { configStub } = require('../../helpers/config_stub');
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const { Readable } = require('stream')

const {
    NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, cryptoNodesDir, dataDir, configDir
} = require('../../../src/config')

// getDefaultConfig() pulls ValidatorService in lazily for the hub module, and
// ValidatorService reads config/validator/ off the REAL filesystem through its own
// `fs` binding, which the fs stub below does not reach. On a developer or operator
// box that has run `xchain-node validator init` that directory exists, so an
// unstubbed run reads the machine's recorded network (HUB_NETWORK) and its live
// signing.key into the config object under test: assertions about a standalone
// install then fail, and a real key ends up in a test fixture. Every factory here
// therefore describes a machine with no validator, which is the state CI runs in
// (config/validator/ is gitignored). Tests that WANT a validator stub their own.
const NO_VALIDATOR = {
    getValidatorSettings: () => null,
    getValidatorEnv:      () => ({}),
    // The hub config states which validator mode it resolved and from where, so a
    // stub that omits this is not a standalone machine, it is a broken module.
    validatorModeReport:  () => ({ mode: 'standalone', dir: '/tmp/test-xchain-config/validator', missing: [] })
}

function makeConfigService(fsStub) {
    return proxyquire('../../../src/services/config_service', {
        'fs': fsStub || require('fs'),
        './validator_service': NO_VALIDATOR
    })
}

// Helper: create a Readable stream from a string (simulates config file)
function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

// Stub fs.createReadStream to return mock config file content
function makeServiceWithConfig(configContent) {
    const fsStub = {
        createReadStream: sinon.stub().callsFake(() => streamFromString(configContent)),
        existsSync: sinon.stub().returns(true),
        // existsSync=true routes upsertSidecarValues into fs.readFileSync on the
        // sidecar; return an empty sidecar so the merge starts from nothing.
        readFileSync: sinon.stub().returns(''),
        appendFileSync: sinon.stub(),
        writeFileSync: sinon.stub(),
        rmSync: sinon.stub(),
        mkdirSync: sinon.stub()
    }
    return makeConfigService(fsStub)
}

// A memory-backed fs so generate -> persist -> read-back is observable across
// calls (the default makeServiceWithConfig stub no-ops writes). Keyed by the
// exact paths ConfigService resolves: config/<coin>-<network>, its .local
// sidecar, and the shared config/hub.local.
// dbContainerId / externalDb control whether DB-password rotation is considered
// possible (a DB container to exec into, or EXTERNAL_DB): per-install passwords are
// only generated where they can be applied to the live account. Default is the
// native, no-container case (rotation impossible -> static default).
function makeMemoryConfigService(initialFiles = {}, { dbContainerId = null, externalDb = false } = {}) {
    const files = { ...initialFiles }
    const fsStub = {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
        createReadStream: (p) => streamFromString(files[p] || ''),
        readFileSync: (p) => files[p] != null ? String(files[p]) : '',
        writeFileSync: (p, body) => { files[p] = String(body) },
        appendFileSync: (p, body) => { files[p] = (files[p] || '') + String(body) },
        chmodSync: () => {},
        mkdirSync: () => {},
        rmSync: (p) => { delete files[p] }
    }
    const cs = proxyquire('../../../src/services/config_service', {
        'fs': fsStub,
        './validator_service': NO_VALIDATOR,
        './database_service': {
            getDatabaseContainerId: async () => dbContainerId,
            getExternalDbConfig: async () => ({ host: '172.18.0.1', port: 3307, root_user: 'root', root_password: 'x' })
        },
        '../config': configStub({ ...require('../../../src/config'), EXTERNAL_DB: externalDb })
    })
    return { cs, files }
}

const CONTAINER_ID = 'a'.repeat(64)
const coinSidecar = path.resolve(configDir, 'bitcoin-mainnet') + '.local'
const coinMain    = path.resolve(configDir, 'bitcoin-mainnet')
const hubSidecar  = path.resolve(configDir, 'hub.local')

module.exports = {
    sinon,
    configStub,
    expect,
    proxyquire,
    path,
    NODE_PREFIX,
    SEP,
    DB_SEP,
    NODE_MODULE_NAME,
    DB_MODULE_NAME,
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME,
    Coin,
    Network,
    XChainService,
    CoinTickerSymbol,
    REGTEST_MODULES,
    moduleDir,
    tmpDir,
    cryptoNodesDir,
    dataDir,
    configDir,
    NO_VALIDATOR,
    makeConfigService,
    streamFromString,
    makeServiceWithConfig,
    makeMemoryConfigService,
    CONTAINER_ID,
    coinSidecar,
    coinMain,
    hubSidecar
}
