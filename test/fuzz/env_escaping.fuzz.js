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

/** Capture Docker run arguments, reconstructed command text, and child environment. */
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

    // Pass only variable names to Docker so values never appear in process listings.
    // Supply raw values through the child environment, where Docker reads bare names.
    // Preserve string coercion because child process environments accept string values.

    // Exercise metacharacters that would be dangerous if a shell interpreted them.
    // Keep every value byte-for-byte intact in the child environment.
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
    // Exercise line breaks that could form extra commands in a shell command string.
    // Keep line breaks inside one child environment value and away from argv.
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

    // Exercise a null byte that execFile itself may reject before spawning Docker.
    // Require only a controlled outcome without shell parsing or argument splitting.
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
    // Exercise extreme lengths without truncating the child environment value.
    // Keep the large value off argv even when its size stresses process creation.
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
    // Exercise non-string configuration values accepted by the configuration layer.
    // Match child process environment semantics by coercing each value with String.
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
    // Exercise nullish configuration values rather than omitting their keys.
    // Preserve explicit entries by coercing null and undefined to their string forms.
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
    // Exercise Unicode and embedded control characters without changing their encoding.
    // Require the execFile boundary to avoid interpreting those characters as syntax.
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

    // Combine dangerous shell characters to catch accidental command-string reconstruction.
    // Keep the combined value solely in the child environment and absent from argv.
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
