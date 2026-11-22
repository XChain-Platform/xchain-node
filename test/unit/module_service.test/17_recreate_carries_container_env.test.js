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

const {
    sinon, expect, makeStubs, makeConfigServiceStub, loadModuleService,
    dockerEnvInspectOutput, moduleSuite
} = require('./support/helpers')
const {
    readContainerEnv,
    carryContainerEnv,
    carryContainerEnvWithProvenance
} = require('../../../src/services/module_service/carry_container_env')
const { RECREATE_DROP_ENV } = require('../../../src/config')

function recordRecreate(stubs, liveEnv, events = []) {
    const seen = []
    stubs.stopContainerByName.callsFake(async () => {
        events.push('stop')
        return { stopped: true, seconds: 1, killed: false }
    })
    stubs.execFile.callsFake((cmd, args, ...rest) => {
        const opts = typeof rest[0] === 'function' ? {} : (rest[0] || {})
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        seen.push({ cmd, args, opts })
        if (args.includes('{{json .Config.Env}}')) {
            events.push('inspect-env')
            cb(null, dockerEnvInspectOutput(liveEnv))
        } else if (args[0] === 'run') {
            events.push('run')
            cb(null, 'e'.repeat(64) + '\n')
        } else {
            cb(null, 'image-id\n')
        }
    })
    return seen
}

function registerCarryContainerEnvBasics() {

    it('reads the explicit recreate drop list through its declared env view', function () {
        const name = 'XCHAIN_NODE_RECREATE_DROP_ENV'
        const saved = process.env[name]
        process.env[name] = 'ORACLE_MIN_SUBMISSIONS'
        try {
            expect(RECREATE_DROP_ENV[name]).to.equal('ORACLE_MIN_SUBMISSIONS')
        } finally {
            if (saved === undefined) delete process.env[name]; else process.env[name] = saved
        }
    })

    it('parses empty and equals-bearing values without exposing or truncating them', async function () {
        const execFileAsync = sinon.stub().resolves({
            stdout: dockerEnvInspectOutput({ AUX_POW: '1', EMPTY: '', TOKEN: 'left=right=tail' })
        })
        expect(await readContainerEnv('old-id', { execFileAsync })).to.deep.equal({
            AUX_POW: '1', EMPTY: '', TOKEN: 'left=right=tail'
        })
    })

    it('lets values from current config replace stale values from the old container', async function () {
        const execFileAsync = sinon.stub().resolves({
            stdout: dockerEnvInspectOutput({ AUX_POW: '1', NETWORK: 'dogecoin-regtest' })
        })
        const merged = await carryContainerEnv(
            { NETWORK: 'dogecoin-mainnet' },
            { reuseImage: true, overwriteContainerId: 'old-id' },
            { execFileAsync }
        )
        expect(merged).to.deep.equal({ AUX_POW: '1', NETWORK: 'dogecoin-mainnet' })
    })

    it('returns current config unchanged when inspect fails or this is not a recreate', async function () {
        const current = { NETWORK: 'bitcoin-mainnet' }
        const failedInspect = sinon.stub().rejects(new Error('daemon unavailable'))
        expect(await carryContainerEnv(
            current,
            { reuseImage: true, overwriteContainerId: 'old-id' },
            { execFileAsync: failedInspect }
        )).to.equal(current)

        const mustNotRun = sinon.stub().rejects(new Error('must not inspect'))
        expect(await carryContainerEnv(
            current,
            { reuseImage: false, overwriteContainerId: 'old-id' },
            { execFileAsync: mustNotRun }
        )).to.equal(current)
        expect(mustNotRun.called).to.equal(false)
    })
}

function registerCarryContainerEnvFallbacks() {
    it('tries the deterministic name when a stale registry id no longer exists', async function () {
        const execFileAsync = sinon.stub().callsFake(async (cmd, args) => {
            if (args[args.length - 1] === 'stale-id') throw new Error('No such container')
            return { stdout: dockerEnvInspectOutput({ AUX_POW: '1' }) }
        })
        const merged = await carryContainerEnv(
            { NETWORK: 'dogecoin-regtest' },
            { reuseImage: true, overwriteContainerId: 'stale-id', containerName: 'rail-decoder' },
            { execFileAsync }
        )
        expect(merged.AUX_POW).to.equal('1')
        expect(execFileAsync.secondCall.args[1]).to.include('rail-decoder')
    })

    it('reports carried names and drops only requested values absent from current config', async function () {
        const execFileAsync = sinon.stub().resolves({
            stdout: dockerEnvInspectOutput({ KEEP: 'old', DROP: 'old', CURRENT: 'old' })
        })
        const result = await carryContainerEnvWithProvenance(
            { CURRENT: 'new' },
            { reuseImage: true, overwriteContainerId: 'old-id' },
            { execFileAsync, dropList: 'DROP,CURRENT,TYPO' }
        )
        expect(result.env).to.deep.equal({ KEEP: 'old', CURRENT: 'new' })
        expect(result.carriedKeys).to.deep.equal(['KEEP'])
        expect(result.droppedKeys).to.deep.equal(['DROP'])
        expect(result.unknownDropKeys).to.deep.equal(['TYPO'])
    })

    it('does not carry node-derived names, while current config and drop recognition still win', async function () {
        const execFileAsync = sinon.stub().resolves({
            stdout: dockerEnvInspectOutput({ SHUTDOWN_TIMEOUT_MS: '100000', KEEP: 'old' })
        })
        const options = { reuseImage: true, overwriteContainerId: 'old-id', neverCarry: ['SHUTDOWN_TIMEOUT_MS'] }
        const omitted = await carryContainerEnvWithProvenance({}, options, {
            execFileAsync, dropList: 'SHUTDOWN_TIMEOUT_MS'
        })
        expect(omitted.env).to.deep.equal({ KEEP: 'old' })
        expect(omitted.carriedKeys).to.deep.equal(['KEEP'])
        expect(omitted.droppedKeys).to.deep.equal(['SHUTDOWN_TIMEOUT_MS'])
        expect(omitted.unknownDropKeys).to.deep.equal([])

        const configured = await carryContainerEnvWithProvenance(
            { SHUTDOWN_TIMEOUT_MS: '45000' }, options, { execFileAsync }
        )
        expect(configured.env.SHUTDOWN_TIMEOUT_MS).to.equal('45000')
    })
}

describe('CarryContainerEnv', function () {
    registerCarryContainerEnvBasics()
    registerCarryContainerEnvFallbacks()
})

async function recreateWithBudget(module, oldDrain, seconds) {
    const key = `XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_${module.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    const saved = process.env[key]
    if (seconds === undefined) delete process.env[key]; else process.env[key] = String(seconds)
    try {
        const stubs = makeStubs()
        const seen = recordRecreate(stubs, { SHUTDOWN_TIMEOUT_MS: oldDrain, KEEP: 'old' })
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(module, 'bitcoin', 'mainnet', 'old-container-id', false, null, { reuseImage: true })
        return seen.find(call => call.args[0] === 'run')
    } finally {
        if (saved === undefined) delete process.env[key]; else process.env[key] = saved
    }
}

function registerBuildAndUpDrainRecreateTest() {
    it('re-derives the drain from raised and lowered budgets and drops it at the plain default', async function () {
        const raised = await recreateWithBudget('xchain-decoder', '100000', 300)
        expect(raised.args).to.include.members(['--stop-timeout', '300'])
        expect(raised.opts.env.SHUTDOWN_TIMEOUT_MS).to.equal('280000')

        const lowered = await recreateWithBudget('xchain-decoder', '100000', 60)
        expect(lowered.args).to.include.members(['--stop-timeout', '60'])
        expect(lowered.opts.env.SHUTDOWN_TIMEOUT_MS).to.equal('40000')

        const defaulted = await recreateWithBudget('xchain-encoder', '70000')
        expect(defaulted.args).to.include.members(['--stop-timeout', '30'])
        expect(defaulted.args).to.not.include('SHUTDOWN_TIMEOUT_MS')
        expect(defaulted.opts.env.SHUTDOWN_TIMEOUT_MS).to.equal(undefined)
        expect(defaulted.opts.env.KEEP).to.equal('old')
    })
}

function registerBuildAndUpRecreateEnvTests() {
    it('passes carried hub names to the consensus guard as provenance', async function () {
        const stubs = makeStubs()
        recordRecreate(stubs, { ORACLE_MIN_SUBMISSIONS: '1' })
        const assertNoHubConsensusEnvDrift = sinon.stub().resolves([])
        const ms = loadModuleService(stubs, undefined, {
            './hub_consensus_env_guard': { assertNoHubConsensusEnvDrift }
        })

        await ms.buildAndUp('xchain-hub', null, null, 'old-container-id', false, null, { reuseImage: true })

        expect(assertNoHubConsensusEnvDrift.firstCall.args[0].ORACLE_MIN_SUBMISSIONS).to.equal('1')
        expect(assertNoHubConsensusEnvDrift.firstCall.args[1].carriedKeys).to.include('ORACLE_MIN_SUBMISSIONS')
    })

    it('carries all shell-only rail values before teardown and keeps them off argv', async function () {
        const stubs = makeStubs()
        const events = []
        const seen = recordRecreate(stubs, {
            AUX_POW: '1',
            XC_ROLLCALL_REGTEST_ACTIVATION: '220',
            HUB_SYNC_ANCHOR_ATTEST_GRACE_S: '0',
            RAIL_VALUE_WITH_EQUALS: 'left=right',
            NETWORK: 'stale-network'
        }, events)
        const configService = makeConfigServiceStub()
        configService.getDefaultConfig = sinon.stub().resolves({
            NETWORK: 'dogecoin-regtest',
            ENCODER_PORT: 3003,
            ENCODER_API_PORT: 3003
        })
        const ms = loadModuleService(stubs, undefined, { './config_service': configService })

        await ms.buildAndUp(
            'xchain-encoder', 'dogecoin', 'regtest', 'old-container-id', false, null,
            { reuseImage: true }
        )

        const envInspect = seen.find(call => call.args.includes('{{json .Config.Env}}'))
        expect(envInspect.args[envInspect.args.length - 1]).to.equal('old-container-id')
        expect(events.indexOf('inspect-env')).to.be.lessThan(events.indexOf('stop'))
        const run = seen.find(call => call.args[0] === 'run')
        expect(run.opts.env.AUX_POW).to.equal('1')
        expect(run.opts.env.XC_ROLLCALL_REGTEST_ACTIVATION).to.equal('220')
        expect(run.opts.env.HUB_SYNC_ANCHOR_ATTEST_GRACE_S).to.equal('0')
        expect(run.opts.env.RAIL_VALUE_WITH_EQUALS).to.equal('left=right')
        expect(run.opts.env.NETWORK).to.equal('dogecoin-regtest')
        expect(run.args).to.not.include('AUX_POW=1')
        expect(run.args).to.include.members(['--env', 'AUX_POW'])
    })
}

function registerBuildAndUpFallbackTest() {
    it('falls back to the container name when the registry lost its id', async function () {
        const stubs = makeStubs()
        const seen = recordRecreate(stubs, { AUX_POW: '1' })
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(
            'xchain-encoder', 'bitcoin', 'mainnet', null, false, null,
            { reuseImage: true }
        )
        const envInspect = seen.find(call => call.args.includes('{{json .Config.Env}}'))
        expect(envInspect.args[envInspect.args.length - 1])
            .to.equal('xchain-node-bitcoin-mainnet-xchain-encoder')
    })
}

moduleSuite('buildAndUp() recreate env carry', function () {
    registerBuildAndUpDrainRecreateTest()
    registerBuildAndUpRecreateEnvTests()
    registerBuildAndUpFallbackTest()
})
