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

const { XChainService } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModuleService(stubs) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'util': { promisify: () => async (cmd, args) => ({ stdout: '', stderr: '' }) },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: (mod, coin, net) => 'xchain-node-' + coin + '-' + net + '-' + mod,
            getDockerNetwork: () => 'xchain-node-bitcoin-mainnet',
            getDefaultConfig: sinon.stub().resolves({
                'ENCODER_PORT': 3003,
                'ENCODER_API_PORT': 3003
            }),
            validatePort: (v) => { const p = Number(v); return Number.isInteger(p) && p >= 1 && p <= 65535 }
        },
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            insertModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves(null),
            removeModuleContainer: sinon.stub().resolves(true)
        }
    }
}

function setupExec(stubs, dockerRunOutput) {
    stubs.execFile.callsFake((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {} }
        if (args && args.includes('build')) {
            cb(null)
        } else if (args && args.includes('run')) {
            cb(null, dockerRunOutput)
        }
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Container ID Validation', function () {

    it('accepts a valid 64-char lowercase hex container ID', async function () {
        const validId = 'a1b2c3d4e5f6'.repeat(5) + 'a1b2c3d4'
        const id = 'abcdef0123456789'.repeat(4)
        expect(id).to.have.length(64)

        const stubs = makeStubs()
        setupExec(stubs, id + '\n')
        const ms = loadModuleService(stubs)
        const result = await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(result).to.equal(id)
    })

    it('accepts all-zero container ID', async function () {
        const id = '0'.repeat(64)
        const stubs = makeStubs()
        setupExec(stubs, id + '\n')
        const ms = loadModuleService(stubs)
        const result = await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(result).to.equal(id)
    })

    it('accepts all-f container ID', async function () {
        const id = 'f'.repeat(64)
        const stubs = makeStubs()
        setupExec(stubs, id + '\n')
        const ms = loadModuleService(stubs)
        const result = await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(result).to.equal(id)
    })

    const invalidIds = [
        ['63 chars (too short)',      'a'.repeat(63)],
        ['65 chars (too long)',       'a'.repeat(65)],
        ['empty string',             ''],
        ['single char',              'a'],
        ['uppercase hex',            'A'.repeat(64)],
        ['mixed case hex',           'aAbBcCdDeEfF'.repeat(5) + 'aAbB'],
        ['non-hex characters (g)',   'g'.repeat(64)],
        ['non-hex characters (z)',   'z'.repeat(64)],
        ['spaces',                   ' '.repeat(64)],
        ['special chars',            '!@#$%^&*()'.repeat(6) + '!@#$'],
        ['null bytes',               '\x00'.repeat(64)],
        ['newlines mixed in',        'a'.repeat(32) + '\n' + 'a'.repeat(31)],
        ['with shell injection',     'a'.repeat(60) + '; rm'],
        ['unicode hex-lookalike',    '\u0430'.repeat(64)], // Cyrillic 'а' looks like 'a'
        ['12-char short hash',       'abcdef012345'],
    ]

    for (const [desc, badId] of invalidIds) {
        it(`rejects invalid container ID: ${desc}`, async function () {
            const stubs = makeStubs()
            setupExec(stubs, badId + '\n')
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
                expect.fail('Should have rejected invalid container ID')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })
    }

    it('trims leading/trailing whitespace from container ID', async function () {
        const id = 'a'.repeat(64)
        const stubs = makeStubs()
        setupExec(stubs, '  ' + id + '  \n')
        const ms = loadModuleService(stubs)
        const result = await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(result).to.equal(id)
    })

    it('rejects container ID that is 64 chars only with whitespace padding', async function () {
        // 60 hex + 4 spaces = 64 total, but after trim it's only 60
        const badId = 'a'.repeat(60) + '    '
        const stubs = makeStubs()
        setupExec(stubs, badId + '\n')
        const ms = loadModuleService(stubs)
        try {
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(err).to.include('Invalid container ID')
        }
    })
})
