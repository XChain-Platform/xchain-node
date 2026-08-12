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
            getDockerNetwork: (coin, net) => 'xchain-node-' + coin + '-' + net,
            getDefaultConfig: sinon.stub().resolves(stubs.envVars || {
                'NETWORK': 'bitcoin-mainnet',
                'NODE_PORT': 8332,
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

function makeStubs(envVars) {
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
        },
        envVars
    }
}

function captureDockerRunArgs(stubs) {
    let runArgs = null
    let runCmd = null
    stubs.execFile.callsFake((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {} }
        if (args && args.includes('build')) {
            cb(null)
        } else if (args && args.includes('run')) {
            runArgs = args
            runCmd = cmd + ' ' + (args || []).join(' ')
            cb(null, 'a'.repeat(64) + '\n')
        }
    })
    return { getCmd: () => runCmd, getArgs: () => runArgs }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Environment Variable Handling with execFile', function () {

    // execFile passes each env var as two raw array elements ('-e', 'KEY=value'),
    // never through a shell, so no escaping or quoting is needed or performed.

    const rawPassthroughInputs = [
        ['double quote',           'val"injection'],
        ['backslash',              'val\\injection'],
        ['dollar sign',            'val$injection'],
        ['backtick',               'val`id`'],
        ['dollar paren',           'val$(whoami)'],
        ['semicolon',              'val;rm -rf /'],
        ['pipe',                   'val|cat /etc/passwd'],
        ['ampersand',              'val&&echo pwned'],
    ]

    for (const [desc, rawValue] of rawPassthroughInputs) {
        it(`passes ${desc} as raw value in args array (no escaping needed)`, async function () {
            const stubs = makeStubs({ 'TEST_KEY': rawValue, 'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 3003 })
            const { getArgs } = captureDockerRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            const args = getArgs()
            expect(args).to.exist

            const eIndex = args.indexOf('-e')
            let found = false
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-e' && args[i + 1] && args[i + 1].startsWith('TEST_KEY=')) {
                    const val = args[i + 1].substring('TEST_KEY='.length)
                    expect(val).to.equal(String(rawValue))
                    found = true
                    break
                }
            }
            expect(found, 'TEST_KEY env var found in args').to.be.true
        })
    }

    it('newline characters are passed raw (safe with execFile)', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'safe_value\n-v /:/host:ro',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a.startsWith('EVIL_KEY='))
        expect(envArg).to.exist
        expect(envArg).to.equal('EVIL_KEY=safe_value\n-v /:/host:ro')
    })

    it('carriage return characters are passed raw (safe with execFile)', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'safe_value\r-v /:/host:ro',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a.startsWith('EVIL_KEY='))
        expect(envArg).to.exist
        expect(envArg).to.equal('EVIL_KEY=safe_value\r-v /:/host:ro')
    })

    it('combined \\r\\n passed raw (safe with execFile)', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'value\r\n--privileged',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a.startsWith('EVIL_KEY='))
        expect(envArg).to.exist
        expect(envArg).to.equal('EVIL_KEY=value\r\n--privileged')
    })

    it('handles null byte in env var value', async function () {
        const stubs = makeStubs({
            'TEST': 'safe\x00malicious',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist
    })

    it('handles extremely long env var value without crashing', async function () {
        const stubs = makeStubs({
            'TEST': 'A'.repeat(100000),
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a.startsWith('TEST='))
        expect(envArg).to.exist
        expect(envArg).to.include('A'.repeat(1000))
    })

    it('handles empty string env var value', async function () {
        const stubs = makeStubs({
            'TEST': '',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a === 'TEST=')
        expect(envArg).to.exist
    })

    it('handles numeric env var value', async function () {
        const stubs = makeStubs({
            'PORT': 8332,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a === 'PORT=8332')
        expect(envArg).to.exist
    })

    it('handles boolean env var value', async function () {
        const stubs = makeStubs({
            'FLAG': false,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a === 'FLAG=false')
        expect(envArg).to.exist
    })

    it('handles null env var value via String() coercion', async function () {
        const stubs = makeStubs({
            'NULLVAL': null,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a === 'NULLVAL=null')
        expect(envArg).to.exist
    })

    it('handles undefined env var value via String() coercion', async function () {
        const stubs = makeStubs({
            'UNDEF': undefined,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a === 'UNDEF=undefined')
        expect(envArg).to.exist
    })

    it('handles unicode characters in env var value', async function () {
        const stubs = makeStubs({
            'TEST': '\u{1F4A9} bitcoin‏',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist
    })

    it('passes all dangerous shell characters raw in a single value (safe with execFile)', async function () {
        const combined = 'a"b\\c$d`e\nf\rg'
        const stubs = makeStubs({
            'COMBINED': combined,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        const envArg = args.find(a => a.startsWith('COMBINED='))
        expect(envArg).to.exist
        expect(envArg).to.equal('COMBINED=' + combined)
    })
})
