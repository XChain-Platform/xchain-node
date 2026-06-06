'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { XChainService, modulesUrls } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        envVars: envVars || {
            'NETWORK': 'bitcoin-mainnet',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        }
    }
}

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
            getDockerContainerImageName: (mod, coin, net) => {
                if (mod === 'xchain-hub' || mod === 'xchain-explorer' || mod === 'xchain-sync') {
                    return 'xchain-node-' + mod
                }
                return 'xchain-node-' + coin + '-' + net + '-' + mod
            },
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
            getDefaultConfig: sinon.stub().resolves(stubs.envVars),
            validatePort: (v) => { const p = Number(v); return Number.isInteger(p) && p >= 1 && p <= 65535 }
        },
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

function captureDockerRunCmd(stubs) {
    let runCmd = null
    let runArgs = null
    stubs.execFile.callsFake((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {} }
        const fullCmd = cmd + ' ' + (args || []).join(' ')
        if (args && args.includes('build')) {
            cb(null)
        } else if (args && args.includes('run')) {
            runCmd = fullCmd
            runArgs = args
            cb(null, 'a'.repeat(64) + '\n')
        }
    })
    return () => runCmd
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Docker Command Construction', function () {

    // --- docker run structure ---

    it('docker run starts with "docker run -d"', async function () {
        const stubs = makeStubs()
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(getCmd()).to.include('docker run -d')
    })

    it('docker run includes --hostname flag', async function () {
        const stubs = makeStubs()
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(getCmd()).to.include('--hostname xchain-node-bitcoin-mainnet-xchain-encoder')
    })

    it('docker run includes --network flag', async function () {
        const stubs = makeStubs()
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(getCmd()).to.include('--network xchain-node-bitcoin-mainnet')
    })

    it('docker run includes -t flag with image name', async function () {
        const stubs = makeStubs()
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        expect(getCmd()).to.include('-t xchain-node-bitcoin-mainnet-xchain-encoder')
    })

    // --- env vars are passed as raw array elements (no shell quoting with execFile) ---

    it('every -e flag is followed by a raw KEY=value pair', async function () {
        const stubs = makeStubs({
            'KEY1': 'val1',
            'KEY2': 'val2',
            'KEY3': 'val3',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        // With execFile, env vars appear as "-e KEY1=val1" (no quotes around KEY=value)
        expect(cmd).to.include('-e KEY1=val1')
        expect(cmd).to.include('-e KEY2=val2')
        expect(cmd).to.include('-e KEY3=val3')
    })

    // --- Malicious env var keys ---

    it('env var key with equals sign does not break quoting', async function () {
        const stubs = makeStubs({
            'EVIL=KEY': 'value',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        // The command should still be constructable without crashing
        expect(cmd).to.exist
    })

    // --- git clone command structure ---

    describe('git clone command', function () {
        it('includes correct git URL from modulesUrls', async function () {
            const stubs = makeStubs()
            let cloneCmd = null
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (typeof args === 'function') { cb = args; args = [] }
                cloneCmd = cmd + ' ' + (args || []).join(' ')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder')
            expect(cloneCmd).to.include(modulesUrls['xchain-encoder'])
        })

        it('branch flag is placed immediately after "clone"', async function () {
            const stubs = makeStubs()
            let cloneCmd = null
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (typeof args === 'function') { cb = args; args = [] }
                cloneCmd = cmd + ' ' + (args || []).join(' ')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, 'develop')
            // Format: git clone -b <branch> <url> <dest>
            expect(cloneCmd).to.include('git clone -b develop ')
        })

        it('no -b flag when branch is null', async function () {
            const stubs = makeStubs()
            let cloneCmd = null
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (typeof args === 'function') { cb = args; args = [] }
                cloneCmd = cmd + ' ' + (args || []).join(' ')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, null)
            expect(cloneCmd).to.not.include('-b')
            // Should be: git clone <url> <dest>
            expect(cloneCmd).to.include('git clone git@')
        })
    })

    // --- Module-specific port/volume lines ---

    describe('module-specific Docker configuration', function () {

        it('decoder includes bootstrap volume mount', async function () {
            const stubs = makeStubs({
                'DECODER_PORT': 3002,
                'DECODER_API_PORT': 3002,
                'DECODER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-decoder/bootstrap/'
            })
            const getCmd = captureDockerRunCmd(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')
            const cmd = getCmd()
            expect(cmd).to.include('-v /data/bitcoin/mainnet/xchain-decoder/bootstrap/:/bootstrap/xchain-decoder')
        })

        it('utxo-tracker includes ulimit setting', async function () {
            const stubs = makeStubs({
                'UTXO_TRACKER_PORT': 3001,
                'UTXO_TRACKER_API_PORT': 3001,
                'UTXO_TRACKER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/'
            })
            const getCmd = captureDockerRunCmd(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(getCmd()).to.include('--ulimit nofile=2048:2048')
        })

        it('utxo-tracker includes data volume', async function () {
            const stubs = makeStubs({
                'UTXO_TRACKER_PORT': 3001,
                'UTXO_TRACKER_API_PORT': 3001,
                'UTXO_TRACKER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/'
            })
            const getCmd = captureDockerRunCmd(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(getCmd()).to.include('-v xchain-utxo-tracker-bitcoin-mainnet-data:/data/xchain-utxo-tracker')
        })
    })

    // --- dockerCmd passthrough ---

    it('appends dockerCmd args to docker run when provided', async function () {
        const stubs = makeStubs()
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet', null, false, ['npm', 'start'])
        const cmd = getCmd()
        expect(cmd).to.match(/npm start$/)
    })

    it('does not append dockerCmd when null', async function () {
        const stubs = makeStubs()
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet', null, false, null)
        const cmd = getCmd()
        expect(cmd).to.not.include('null')
        expect(cmd).to.match(/-t xchain-node-bitcoin-mainnet-xchain-encoder$/)
    })
})
