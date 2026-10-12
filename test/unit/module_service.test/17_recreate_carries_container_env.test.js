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
    carryContainerEnv
} = require('../../../src/services/module_service/carry_container_env')

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

describe('CarryContainerEnv', function () {

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
})

moduleSuite('buildAndUp() recreate env carry', function () {

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
})
