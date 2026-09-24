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

const { EventEmitter } = require('events')
const { expect } = require('chai')
const sinon = require('sinon')

const LOGGER_PATH = require.resolve('../../../src/observability/logger.js')
const CONFIG_PATH = require.resolve('../../../src/config/index.js')
const RELEASE_PATH = require.resolve('../../../src/services/release_signature_service.js')
const UPDATE_PATH = require.resolve('../../../src/services/self_update_service.js')
const STAKE_PATH = require.resolve('../../../src/services/validator_stake_service/stake_operations.js')
const UNSTAKE_PATH = require.resolve('../../../src/services/validator_stake_service/unstake_operations.js')

let loggerCacheEntry
let configCacheEntry
let cachedModules
let logger
let getLogger
let output

function loadService(modulePath) {
    if (!cachedModules.has(modulePath)) cachedModules.set(modulePath, require.cache[modulePath])
    delete require.cache[modulePath]
    return require(modulePath)
}

function expectNoGlobalOutput() {
    expect(output.log.called, 'global log sink').to.equal(false)
    expect(output.warn.called, 'global warn sink').to.equal(false)
    expect(output.error.called, 'global error sink').to.equal(false)
}

function operationHelpers() {
    const pubkey = 'ab'.repeat(32)
    const sdk = {
        explorer: {
            getValidators: sinon.stub().resolves({ data: [] })
        }
    }
    return {
        openValidatorSession: () => ({
            network: 'testnet',
            coins: { stakeCoin: 'TBTC' },
            pubkey,
            sdk,
            session: {},
            address: 'mStakeAddress'
        }),
        stakeTiming: () => ({
            activationBlocks: 6,
            cooldownBlocks: 1000,
            activationFor: 'roughly 60 minutes',
            cooldownFor: 'roughly 7 days'
        }),
        readChainState: sinon.stub().resolves({
            coinBal: 1,
            coinPending: 0,
            tokenBal: 25000,
            mintMax: 10000,
            mintAddressMax: 50000,
            existing: null,
            existingUnknown: null
        }),
        planMints: () => ({ short: 0, mints: [], reason: null }),
        explorerUrl: () => '/validator/' + pubkey,
        chainedInputs: sinon.stub(),
        waitForBalance: sinon.stub(),
        fail: message => new Error(message),
        paren: text => text ? ` (${text})` : '',
        STAKE_TICK: 'XCHAIN',
        DEFAULT_STAKE_AMOUNT: 25000
    }
}

function installStubs() {
    cachedModules = new Map()
    logger = {
        info: sinon.spy(),
        warn: sinon.spy(),
        error: sinon.spy()
    }
    getLogger = sinon.stub().returns(logger)

    loggerCacheEntry = require.cache[LOGGER_PATH]
    configCacheEntry = require.cache[CONFIG_PATH]
    require.cache[LOGGER_PATH] = {
        id: LOGGER_PATH,
        filename: LOGGER_PATH,
        loaded: true,
        exports: { getLogger }
    }

    output = {
        log: sinon.spy(console, 'log'),
        warn: sinon.spy(console, 'warn'),
        error: sinon.spy(console, 'error')
    }
}

function restoreStubs() {
    delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE
    for (const [modulePath, entry] of cachedModules) {
        delete require.cache[modulePath]
        if (entry) require.cache[modulePath] = entry
    }
    delete require.cache[LOGGER_PATH]
    if (loggerCacheEntry) require.cache[LOGGER_PATH] = loggerCacheEntry
    delete require.cache[CONFIG_PATH]
    if (configCacheEntry) require.cache[CONFIG_PATH] = configCacheEntry
    sinon.restore()
}

function useStubs() {
    beforeEach(installStubs)
    afterEach(restoreStubs)
}

describe('release signature adapter', function () {
    useStubs()

    it('routes the unsigned-release fallback through getLogger().warn', async function () {
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE = '0'
        const { verifyManifestForTag } = loadService(RELEASE_PATH)
        const callsBefore = getLogger.callCount

        const result = await verifyManifestForTag({
            tag: 'v1.2.3',
            manifestBytes: Buffer.from('{}'),
            fetchAsset: sinon.stub().resolves(null)
        })

        expect(result.verified).to.equal(false)
        expect(getLogger.callCount).to.equal(callsBefore + 1)
        expect(logger.warn.calledWithMatch(/WITHOUT release signature verification/)).to.equal(true)
        expectNoGlobalOutput()
    })
})

describe('self update adapter', function () {
    useStubs()

    it('routes self-update progress, warning and spawn failure through getLogger()', async function () {
        const { selfUpdateAndReexec } = loadService(UPDATE_PATH)
        const callsBefore = getLogger.callCount
        const child = new EventEmitter()
        const spawn = sinon.stub().callsFake(() => {
            setImmediate(() => child.emit('error', new Error('spawn failed')))
            return child
        })

        await selfUpdateAndReexec({
            tag: 'v1.2.3',
            childArgs: ['update', 'all', 'all', 'all', 'v1.2.3'],
            deps: {
                env: {},
                currentVersion: () => '1.2.2',
                describeCarrier: sinon.stub().resolves({
                    isRepo: true,
                    commit: 'c'.repeat(40),
                    dirty: []
                }),
                execFile: sinon.stub().resolves({ stdout: '' }),
                verifyGitTagSignature: sinon.stub().throws(new Error('signature unavailable')),
                signatureCheckDisabled: () => true,
                spawn,
                exit: sinon.stub()
            }
        })

        expect(getLogger.callCount).to.equal(callsBefore + 1)
        expect(logger.info.calledWithMatch(/Updating the xchain-node CLI/)).to.equal(true)
        expect(logger.warn.calledWithMatch(/WITHOUT verifying its tag/)).to.equal(true)
        expect(logger.error.calledWithMatch(/Could not re-run xchain-node/)).to.equal(true)
        expectNoGlobalOutput()
    })

    it('routes the newer-release notice through getLogger().info', async function () {
        const { noticeNewerRelease } = loadService(UPDATE_PATH)
        const callsBefore = getLogger.callCount

        const tag = await noticeNewerRelease({
            env: {},
            currentVersion: () => '1.2.2',
            resolveLatestReleaseTag: sinon.stub().resolves('v1.2.3'),
            readCheckCache: () => null,
            writeCheckCache: sinon.stub()
        })

        expect(tag).to.equal('v1.2.3')
        expect(getLogger.callCount).to.equal(callsBefore + 1)
        expect(logger.info.calledWithMatch(/A newer XChain release is available/)).to.equal(true)
        expectNoGlobalOutput()
    })
})

describe('injected logger seams', function () {
    useStubs()

    it('preserves injected object loggers without consulting the default adapter', async function () {
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE = '0'
        const { verifyManifestForTag } = loadService(RELEASE_PATH)
        const { noticeNewerRelease } = loadService(UPDATE_PATH)
        const releaseLogger = { log: sinon.spy(), warn: sinon.spy(), error: sinon.spy() }
        const updateLogger = { log: sinon.spy(), warn: sinon.spy(), error: sinon.spy() }
        const callsBefore = getLogger.callCount

        await verifyManifestForTag({
            tag: 'v1.2.3',
            manifestBytes: Buffer.from('{}'),
            fetchAsset: sinon.stub().resolves(null),
            logger: releaseLogger
        })
        await noticeNewerRelease({
            env: {},
            logger: updateLogger,
            currentVersion: () => '1.2.2',
            resolveLatestReleaseTag: sinon.stub().resolves('v1.2.3'),
            readCheckCache: () => null,
            writeCheckCache: sinon.stub()
        })

        expect(releaseLogger.warn.calledOnce).to.equal(true)
        expect(updateLogger.log.calledOnce).to.equal(true)
        expect(getLogger.callCount).to.equal(callsBefore)
        expectNoGlobalOutput()
    })

    it('preserves the stake and unstake deps.log callback seam', async function () {
        const { createStakeValidator } = loadService(STAKE_PATH)
        const { createUnstakeValidator } = loadService(UNSTAKE_PATH)
        const helpers = operationHelpers()
        const stakeLog = sinon.spy()
        const unstakeLog = sinon.spy()
        const callsBefore = getLogger.callCount

        await createStakeValidator(helpers)({}, { log: stakeLog })
        await createUnstakeValidator(helpers)({}, { log: unstakeLog })

        expect(stakeLog.called).to.equal(true)
        expect(unstakeLog.called).to.equal(true)
        expect(getLogger.callCount).to.equal(callsBefore)
        expectNoGlobalOutput()
    })
})

describe('stake default logger', function () {
    useStubs()

    it('routes stake and unstake defaults through getLogger().info', async function () {
        const { createStakeValidator } = loadService(STAKE_PATH)
        const { createUnstakeValidator } = loadService(UNSTAKE_PATH)
        const helpers = operationHelpers()
        const callsBefore = getLogger.callCount

        await createStakeValidator(helpers)({}, {})
        await createUnstakeValidator(helpers)({}, {})

        expect(getLogger.callCount).to.equal(callsBefore + 2)
        expect(logger.info.called).to.equal(true)
        expectNoGlobalOutput()
    })
})
