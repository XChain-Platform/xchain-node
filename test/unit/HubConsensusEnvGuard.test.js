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

const {
    DRIFT_OVERRIDE_ENV,
    DRIFT_ERROR_CODE,
    CONSENSUS_ENV_KEYS,
    describeConsensusEnvSupply,
    findHubConsensusEnvDrift,
    formatHubConsensusEnvDriftError,
    logConsensusEnvSupplyState,
    assertNoHubConsensusEnvDrift,
    isHubConsensusEnvDriftError
} = require('../../src/services/HubConsensusEnvGuard')

// A `docker inspect --format {{json .Config.Env}}` response for one container.
function inspectStub(env) {
    return sinon.stub().resolves({ stdout: JSON.stringify(Object.keys(env).map(k => `${k}=${env[k]}`)) + '\n' })
}
function missingContainerStub() {
    return sinon.stub().rejects(new Error('No such container'))
}

describe('HubConsensusEnvGuard', () => {

    it('covers the five named consensus-shaped var groups', () => {
        // Pinned so a future edit to the group table cannot silently drop one of
        // the row's named vars without a red test.
        expect(CONSENSUS_ENV_KEYS).to.include.members([
            'HUB_NETWORK',
            'ORACLE_MIN_SUBMISSIONS',
            'ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW',
            'XCHAIN_PRICE_INDEXER_DB_HOST', 'XCHAIN_PRICE_INDEXER_DB_PORT',
            'XCHAIN_PRICE_INDEXER_DB_NAME', 'XCHAIN_PRICE_INDEXER_DB_USER',
            'XCHAIN_PRICE_INDEXER_DB_PASS', 'XCHAIN_PRICE_INDEXER_DB_COIN'
        ])
    })

    describe('describeConsensusEnvSupply()', () => {

        it('splits supplied from defaulted', () => {
            const { supplied, defaulted } = describeConsensusEnvSupply({
                HUB_NETWORK: 'regtest',
                ORACLE_MIN_SUBMISSIONS: '1'
            })
            expect(supplied).to.deep.equal(['HUB_NETWORK', 'ORACLE_MIN_SUBMISSIONS'])
            expect(defaulted).to.include('ORACLE_ROUND_INTERVAL', 'XCHAIN_PRICE_INDEXER_DB_HOST')
        })

        it('treats an empty string the same as unset (defaulted)', () => {
            const { supplied, defaulted } = describeConsensusEnvSupply({ HUB_NETWORK: '' })
            expect(supplied).to.not.include('HUB_NETWORK')
            expect(defaulted).to.include('HUB_NETWORK')
        })

        it('treats a null/undefined intended object as everything defaulted', () => {
            const { supplied, defaulted } = describeConsensusEnvSupply(undefined)
            expect(supplied).to.deep.equal([])
            expect(defaulted).to.deep.equal(CONSENSUS_ENV_KEYS)
        })
    })

    describe('findHubConsensusEnvDrift()', () => {

        it('reports nothing when there is no running container', () => {
            expect(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, null)).to.deep.equal([])
        })

        it('reports nothing when the deploy agrees with the running container', () => {
            const drift = findHubConsensusEnvDrift(
                { ORACLE_MIN_SUBMISSIONS: '1' },
                { ORACLE_MIN_SUBMISSIONS: '1' }
            )
            expect(drift).to.deep.equal([])
        })

        it('reports nothing when the running container never carried the key', () => {
            // The container ran fine without it; there is nothing this deploy could lose.
            const drift = findHubConsensusEnvDrift({}, { SOME_OTHER_VAR: 'x' })
            expect(drift).to.deep.equal([])
        })

        // The exact shape this row describes: a shell missing the var silently
        // drops a value the running hub already has.
        it('flags a key the deploy would silently DROP (present live, absent from the new deploy)', () => {
            const drift = findHubConsensusEnvDrift({}, { ORACLE_MIN_SUBMISSIONS: '1' })
            expect(drift).to.deep.equal([{ key: 'ORACLE_MIN_SUBMISSIONS' }])
        })

        it('flags a key the deploy would silently CHANGE (present but different)', () => {
            const drift = findHubConsensusEnvDrift(
                { HUB_NETWORK: 'testnet' },
                { HUB_NETWORK: 'regtest' }
            )
            expect(drift).to.deep.equal([{ key: 'HUB_NETWORK' }])
        })

        it('flags every drifted key in one pass, not just the first', () => {
            const drift = findHubConsensusEnvDrift(
                {},
                { ORACLE_ROUND_INTERVAL: '5000', ORACLE_SUBMISSION_WINDOW: '3000' }
            )
            expect(drift.map(d => d.key).sort()).to.deep.equal(['ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW'])
        })

        it('compares the price-indexer DB password without ever needing to log it', () => {
            const drift = findHubConsensusEnvDrift({}, { XCHAIN_PRICE_INDEXER_DB_PASS: 'topsecret' })
            expect(drift).to.deep.equal([{ key: 'XCHAIN_PRICE_INDEXER_DB_PASS' }])
        })
    })

    describe('formatHubConsensusEnvDriftError()', () => {

        it('names the drifted keys and the override escape hatch, never a value', () => {
            const msg = formatHubConsensusEnvDriftError([{ key: 'ORACLE_MIN_SUBMISSIONS' }, { key: 'HUB_NETWORK' }])
            expect(msg).to.contain('ORACLE_MIN_SUBMISSIONS')
            expect(msg).to.contain('HUB_NETWORK')
            expect(msg).to.contain(DRIFT_OVERRIDE_ENV)
            expect(msg).to.not.contain('topsecret')
        })
    })

    describe('logConsensusEnvSupplyState()', () => {
        let warnStub, logStub
        beforeEach(() => {
            warnStub = sinon.stub(console, 'warn')
            logStub  = sinon.stub(console, 'log')
        })
        afterEach(() => {
            warnStub.restore()
            logStub.restore()
        })

        it('warns naming every defaulted key when nothing is supplied', () => {
            logConsensusEnvSupplyState({})
            expect(warnStub.calledOnce).to.equal(true)
            expect(warnStub.firstCall.args[0]).to.contain('ORACLE_MIN_SUBMISSIONS')
            expect(warnStub.firstCall.args[0]).to.contain('HUB_NETWORK')
        })

        it('logs (not warns) the supplied keys and stays silent about warning when all are supplied', () => {
            const full = {}
            for (const k of CONSENSUS_ENV_KEYS) full[k] = 'x'
            logConsensusEnvSupplyState(full)
            expect(warnStub.called).to.equal(false)
            expect(logStub.calledOnce).to.equal(true)
            expect(logStub.firstCall.args[0]).to.contain('HUB_NETWORK')
        })
    })

    describe('assertNoHubConsensusEnvDrift()', () => {
        let warnStub, logStub
        beforeEach(() => {
            warnStub = sinon.stub(console, 'warn')
            logStub  = sinon.stub(console, 'log')
        })
        afterEach(() => {
            warnStub.restore()
            logStub.restore()
        })

        it('is a no-op (returns empty) on a fresh install with no running hub container', async () => {
            const drift = await assertNoHubConsensusEnvDrift(
                { HUB_NETWORK: 'regtest' },
                { execFileAsync: missingContainerStub(), env: {} }
            )
            expect(drift).to.deep.equal([])
        })

        it('resolves when the running hub agrees with the new deploy', async () => {
            const drift = await assertNoHubConsensusEnvDrift(
                { ORACLE_MIN_SUBMISSIONS: '1' },
                { execFileAsync: inspectStub({ ORACLE_MIN_SUBMISSIONS: '1' }), env: {} }
            )
            expect(drift).to.deep.equal([])
        })

        it('throws a tagged error when the running hub would lose a value', async () => {
            let thrown = null
            try {
                await assertNoHubConsensusEnvDrift(
                    {},
                    { execFileAsync: inspectStub({ ORACLE_MIN_SUBMISSIONS: '1' }), env: {} }
                )
            } catch (err) { thrown = err }
            expect(thrown).to.be.an('error')
            expect(thrown.code).to.equal(DRIFT_ERROR_CODE)
            expect(thrown.drift).to.deep.equal([{ key: 'ORACLE_MIN_SUBMISSIONS' }])
            expect(isHubConsensusEnvDriftError(thrown)).to.equal(true)
        })

        it('proceeds and logs when the override env is set', async () => {
            const drift = await assertNoHubConsensusEnvDrift(
                {},
                {
                    execFileAsync: inspectStub({ HUB_NETWORK: 'mainnet' }),
                    env: { [DRIFT_OVERRIDE_ENV]: '1' }
                }
            )
            expect(drift).to.deep.equal([{ key: 'HUB_NETWORK' }])
        })
    })

    describe('isHubConsensusEnvDriftError()', () => {

        it('separates this guard\'s refusal from an unrelated failure', () => {
            const drift = new Error('lost a value')
            drift.code = DRIFT_ERROR_CODE
            expect(isHubConsensusEnvDriftError(drift)).to.equal(true)
            expect(isHubConsensusEnvDriftError(new Error('docker network failure'))).to.equal(false)
            expect(isHubConsensusEnvDriftError(null)).to.equal(false)
            expect(isHubConsensusEnvDriftError('a string throw')).to.equal(false)
        })
    })
})
