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

const { XChainService } = require('../../src/config')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModuleService(stubs) {
    return proxyquire('../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'util': { promisify: () => async (cmd, args) => ({ stdout: '', stderr: '' }) },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
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
        './status_service': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './docker_service': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
        './database_service': { setDatabaseParameters: sinon.stub().resolves() }
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
            setModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves(null),
            deleteModuleContainer: sinon.stub().resolves(true)
        },
        envVars
    }
}

/**
 * Captures the args array from the `docker run` execFile call.
 * Returns a getter for the full reconstructed command string and the raw args.
 */
function captureDockerRunArgs(stubs) {
    let runArgs = null
    let runCmd = null
    let runEnv = null
    stubs.execFile.callsFake((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {} }
        if (args && args.includes('build')) {
            cb(null)
        } else if (args && args.includes('run')) {
            runArgs = args
            runCmd = cmd + ' ' + (args || []).join(' ')
            runEnv = opts.env
            cb(null, 'a'.repeat(64) + '\n')
        }
    })
    return { getCmd: () => runCmd, getArgs: () => runArgs, getEnv: () => runEnv }
}

function expectDockerEnv(args, env, key, value) {
    const index = args.indexOf(key)
    expect(index).to.be.greaterThan(0)
    expect(args[index - 1]).to.equal('--env')
    expect(args.some(arg => String(arg).startsWith(key + '='))).to.be.false
    expect(env[key]).to.equal(String(value))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Environment Variable Handling with execFile', function () {

    // Docker receives bare env names on argv and raw values in the child env.

    // --- Values with shell metacharacters pass through raw ---
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
        it(`passes ${desc} as a raw child env value without exposing it on argv`, async function () {
            const stubs = makeStubs({ 'TEST_KEY': rawValue, 'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 3003 })
            const { getArgs, getEnv } = captureDockerRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            const args = getArgs()
            expect(args).to.exist
            expectDockerEnv(args, getEnv(), 'TEST_KEY', rawValue)
        })
    }
})

describe('Fuzz: Environment Variable Handling with execFile', function () {
    // --- Newline / carriage return values are passed as raw child env strings ---
    it('newline characters are passed through the child env', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'safe_value\n-v /:/host:ro',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'EVIL_KEY', 'safe_value\n-v /:/host:ro')
    })

    it('carriage return characters are passed through the child env', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'safe_value\r-v /:/host:ro',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'EVIL_KEY', 'safe_value\r-v /:/host:ro')
    })
})

describe('Fuzz: Environment Variable Handling with execFile', function () {
    it('combined \\r\\n is passed through the child env', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'value\r\n--privileged',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'EVIL_KEY', 'value\r\n--privileged')
    })

    // --- Null byte and binary data ---
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
})

describe('Fuzz: Environment Variable Handling with execFile', function () {
    // --- Extreme lengths ---
    it('handles extremely long env var value without crashing', async function () {
        const stubs = makeStubs({
            'TEST': 'A'.repeat(100000),
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'TEST', 'A'.repeat(100000))
    })

    it('handles empty string env var value', async function () {
        const stubs = makeStubs({
            'TEST': '',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'TEST', '')
    })
})

describe('Fuzz: Environment Variable Handling with execFile', function () {
    // --- Type coercion ---
    it('handles numeric env var value', async function () {
        const stubs = makeStubs({
            'PORT': 8332,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'PORT', 8332)
    })

    it('handles boolean env var value', async function () {
        const stubs = makeStubs({
            'FLAG': false,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'FLAG', false)
    })
})

describe('Fuzz: Environment Variable Handling with execFile', function () {
    it('handles null env var value via String() coercion', async function () {
        const stubs = makeStubs({
            'NULLVAL': null,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'NULLVAL', null)
    })

    it('handles undefined env var value via String() coercion', async function () {
        const stubs = makeStubs({
            'UNDEF': undefined,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'UNDEF', undefined)
    })
})

describe('Fuzz: Environment Variable Handling with execFile', function () {
    // --- Unicode / special encoding ---
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

    // --- Comprehensive: all dangerous chars in one value ---
    it('passes all dangerous shell characters through the child env', async function () {
        const combined = 'a"b\\c$d`e\nf\rg'
        const stubs = makeStubs({
            'COMBINED': combined,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const { getArgs, getEnv } = captureDockerRunArgs(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const args = getArgs()
        expect(args).to.exist

        expectDockerEnv(args, getEnv(), 'COMBINED', combined)
    })
})
