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

const sinon = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const DECODER = 'xchain-decoder'
const INDEXER = 'xchain-indexer'
const HUB     = 'xchain-hub'

function load() {
    return proxyquire('../../../src/services/db_credential_drift', {
        '../config': configStub({
            XChainService: { XCHAIN_DECODER: DECODER, XCHAIN_INDEXER: INDEXER },
            HUB_MODULE_NAME: HUB
        }),
        './config_service': {
            getDockerContainerImageName: (mod, coin, net) => `xchain-node-${coin}-${net}-${mod}`
        }
    })
}

// A `docker inspect --format {{json .Config.Env}}` response for one container.
function inspectStub(envsByName) {
    return sinon.stub().callsFake(async (cmd, args) => {
        const name = args[args.length - 1]
        const env = envsByName[name]
        if (!env) throw new Error('No such container: ' + name)
        return { stdout: JSON.stringify(Object.keys(env).map(k => `${k}=${env[k]}`)) + '\n' }
    })
}

describe('DbCredentialDrift', () => {

    describe('assertNoDbCredentialDrift', () => {

        const CONTAINERS = {
            'xchain-node-dogecoin-regtest-xchain-decoder': { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'ipass' },
            'xchain-node-dogecoin-regtest-xchain-indexer': { DECODER_DB_PASS: 'dpass-stale', INDEXER_DB_PASS: 'ipass-stale' }
        }

        it('resolves when the running containers agree with the config', async () => {
            const { assertNoDbCredentialDrift } = load()
            const drift = await assertNoDbCredentialDrift('dogecoin', 'regtest',
                { decoder: 'dpass', indexer: 'ipass' },
                {
                    execFileAsync: inspectStub({
                        'xchain-node-dogecoin-regtest-xchain-decoder': { DECODER_DB_PASS: 'dpass' },
                        'xchain-node-dogecoin-regtest-xchain-indexer': { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'ipass' }
                    }),
                    env: {}
                })
            expect(drift).to.deep.equal([])
        })

        it('throws a tagged error naming the locked-out container', async () => {
            const { assertNoDbCredentialDrift, DRIFT_ERROR_CODE } = load()
            let thrown = null
            try {
                await assertNoDbCredentialDrift('dogecoin', 'regtest',
                    { decoder: 'dpass', indexer: 'ipass' },
                    { execFileAsync: inspectStub(CONTAINERS), env: {} })
            } catch (err) { thrown = err }
            expect(thrown).to.be.an('error')
            expect(thrown.code).to.equal(DRIFT_ERROR_CODE)
            expect(thrown.message).to.contain('xchain-node-dogecoin-regtest-xchain-indexer')
            expect(thrown.drift).to.have.length(2)
        })

        it('proceeds with a warning when the override env is set', async () => {
            const { assertNoDbCredentialDrift, DRIFT_OVERRIDE_ENV } = load()
            const log = sinon.stub(console, 'log')
            try {
                const drift = await assertNoDbCredentialDrift('dogecoin', 'regtest',
                    { decoder: 'dpass', indexer: 'ipass' },
                    { execFileAsync: inspectStub(CONTAINERS), env: { [DRIFT_OVERRIDE_ENV]: '1' } })
                expect(drift).to.have.length(2)
            } finally {
                log.restore()
            }
        })

        it('is a no-op when no decoder or indexer container is running', async () => {
            const { assertNoDbCredentialDrift } = load()
            const drift = await assertNoDbCredentialDrift('dogecoin', 'regtest',
                { decoder: 'dpass', indexer: 'ipass' },
                { execFileAsync: inspectStub({}), env: {} })
            expect(drift).to.deep.equal([])
        })
    })

    describe('assertNoDbCredentialDrift', () => {

        // uuid:cb0bd3be: the pre-flight caller runs this guard BEFORE it replaces a
        // container, so the container it is about to replace must not count as drift.
        it('ignores the container the caller is about to replace', async () => {
            const { assertNoDbCredentialDrift } = load()
            const inspect = inspectStub({
                'xchain-node-dogecoin-regtest-xchain-decoder': { DECODER_DB_PASS: 'dpass-stale' },
                'xchain-node-dogecoin-regtest-xchain-indexer': { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'ipass' }
            })
            const drift = await assertNoDbCredentialDrift('dogecoin', 'regtest',
                { decoder: 'dpass', indexer: 'ipass' },
                { execFileAsync: inspect, env: {}, excludeModules: [DECODER] })
            expect(drift).to.deep.equal([])
            // Not merely filtered out of the result: the excluded container is never inspected.
            const inspected = inspect.getCalls().map(c => c.args[1][c.args[1].length - 1])
            expect(inspected).to.not.contain('xchain-node-dogecoin-regtest-xchain-decoder')
        })

        it('still flags a sibling that would be locked out, and names the excluded module in the remedy', async () => {
            const { assertNoDbCredentialDrift, DRIFT_ERROR_CODE } = load()
            let thrown = null
            try {
                await assertNoDbCredentialDrift('dogecoin', 'regtest',
                    { decoder: 'dpass', indexer: 'ipass' },
                    {
                        execFileAsync: inspectStub({
                            'xchain-node-dogecoin-regtest-xchain-decoder': { DECODER_DB_PASS: 'dpass-stale' },
                            'xchain-node-dogecoin-regtest-xchain-indexer': { DECODER_DB_PASS: 'dpass-stale', INDEXER_DB_PASS: 'ipass' }
                        }),
                        env: {},
                        excludeModules: [DECODER]
                    })
            } catch (err) { thrown = err }
            expect(thrown).to.be.an('error')
            expect(thrown.code).to.equal(DRIFT_ERROR_CODE)
            expect(thrown.drift).to.have.length(1)
            expect(thrown.drift[0].module).to.equal(INDEXER)
            // The excluded module shares the account, so recreating only the flagged
            // one converges half the stack and leaves the other half locked out.
            expect(thrown.message).to.contain(`recreate ${INDEXER} ${DECODER}`)
        })
    })
})
