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
    resolveHubNetwork,
    isConsensusEnvKeyHonoredOn,
    consensusEnvKeysForNetwork,
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

    // The regtest-only XCHAIN/BTC derivation overrides: honored by
    // XchainPriceSource.pinOffRegtest only when HUB_NETWORK is regtest, pinned to
    // the constants.js values everywhere else.
    const REGTEST_ONLY_KEYS = [
        'XCHAIN_PRICE_WINDOW_BLOCKS', 'XCHAIN_PRICE_CONFIRMATION_BUFFER',
        'XCHAIN_PRICE_BOOTSTRAP_SATS', 'XCHAIN_PRICE_MIN_BTC_VOLUME'
    ]

    it('covers the named consensus-shaped var groups', () => {
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

    it('covers the four regtest-only XCHAIN/BTC derivation overrides too', () => {
        expect(CONSENSUS_ENV_KEYS).to.include.members(REGTEST_ONLY_KEYS)
    })

    describe('network gating', () => {

        it('resolves the network from this deploy\'s own HUB_NETWORK first', () => {
            expect(resolveHubNetwork({ HUB_NETWORK: 'Regtest' }, { HUB_NETWORK: 'mainnet' })).to.equal('regtest')
        })

        it('falls back to the running container when the invoking shell dropped HUB_NETWORK', () => {
            // A recreate whose shell lacks HUB_NETWORK is still recreating the
            // regtest hub that is running right now.
            expect(resolveHubNetwork({}, { HUB_NETWORK: 'regtest' })).to.equal('regtest')
            expect(resolveHubNetwork({ HUB_NETWORK: '' }, { HUB_NETWORK: 'regtest' })).to.equal('regtest')
        })

        it('resolves standalone (unset everywhere) to the empty network', () => {
            expect(resolveHubNetwork({}, null)).to.equal('')
            expect(resolveHubNetwork(undefined, undefined)).to.equal('')
        })

        it('honors the derivation overrides on regtest and nowhere else', () => {
            for (const key of REGTEST_ONLY_KEYS) {
                expect(isConsensusEnvKeyHonoredOn(key, 'regtest'), key).to.equal(true)
                expect(isConsensusEnvKeyHonoredOn(key, 'testnet'), key).to.equal(false)
                expect(isConsensusEnvKeyHonoredOn(key, 'mainnet'), key).to.equal(false)
                // Standalone fails closed to the pin, exactly as the hub's other
                // consensus-adjacent seams do.
                expect(isConsensusEnvKeyHonoredOn(key, ''), key).to.equal(false)
            }
        })

        it('leaves the ungated keys, including the per-operator DB source, honored on every network', () => {
            for (const network of ['regtest', 'testnet', 'mainnet', '']) {
                expect(isConsensusEnvKeyHonoredOn('HUB_NETWORK', network)).to.equal(true)
                expect(isConsensusEnvKeyHonoredOn('ORACLE_MIN_SUBMISSIONS', network)).to.equal(true)
                // Gating these would take every non-regtest hub off the pair.
                expect(isConsensusEnvKeyHonoredOn('XCHAIN_PRICE_INDEXER_DB_HOST', network)).to.equal(true)
            }
        })

        it('scopes the walked key list to the network', () => {
            expect(consensusEnvKeysForNetwork('regtest')).to.deep.equal(CONSENSUS_ENV_KEYS)
            const mainnetKeys = consensusEnvKeysForNetwork('mainnet')
            for (const key of REGTEST_ONLY_KEYS) expect(mainnetKeys).to.not.include(key)
            expect(mainnetKeys).to.include('XCHAIN_PRICE_INDEXER_DB_HOST')
        })
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
            // Scoped to the network, which is unset here: the regtest-only
            // overrides are not "missing", they are inapplicable.
            expect(defaulted).to.deep.equal(consensusEnvKeysForNetwork(''))
        })

        it('does not report a regtest-only override as missing on a mainnet deploy', () => {
            const { defaulted } = describeConsensusEnvSupply({ HUB_NETWORK: 'mainnet' })
            for (const key of REGTEST_ONLY_KEYS) expect(defaulted).to.not.include(key)
        })

        it('does report a regtest-only override as missing on a regtest deploy', () => {
            const { defaulted } = describeConsensusEnvSupply({ HUB_NETWORK: 'regtest' })
            expect(defaulted).to.include.members(REGTEST_ONLY_KEYS)
        })

        it('takes an explicit network, for the caller that resolved it from the live container', () => {
            const { supplied } = describeConsensusEnvSupply({ XCHAIN_PRICE_BOOTSTRAP_SATS: '5000' }, 'regtest')
            expect(supplied).to.deep.equal(['XCHAIN_PRICE_BOOTSTRAP_SATS'])
            expect(describeConsensusEnvSupply({ XCHAIN_PRICE_BOOTSTRAP_SATS: '5000' }, 'mainnet').supplied)
                .to.deep.equal([])
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

        // The trap this row exists to avoid: guarding the derivation overrides
        // everywhere would refuse the deploy that unsets a variable the hub has
        // already been ignoring for its whole life.
        it('does NOT call it drift when a mainnet deploy unsets an override the hub already ignores', () => {
            const drift = findHubConsensusEnvDrift(
                { HUB_NETWORK: 'mainnet' },
                { HUB_NETWORK: 'mainnet', XCHAIN_PRICE_BOOTSTRAP_SATS: '5000', XCHAIN_PRICE_WINDOW_BLOCKS: '10' }
            )
            expect(drift).to.deep.equal([])
        })

        it('does NOT call it drift when a testnet or standalone deploy unsets one either', () => {
            expect(findHubConsensusEnvDrift(
                { HUB_NETWORK: 'testnet' },
                { HUB_NETWORK: 'testnet', XCHAIN_PRICE_MIN_BTC_VOLUME: '0' }
            )).to.deep.equal([])
            expect(findHubConsensusEnvDrift({}, { XCHAIN_PRICE_CONFIRMATION_BUFFER: '0' })).to.deep.equal([])
        })

        it('does NOT call it drift when a mainnet deploy CHANGES an override the hub ignores', () => {
            const drift = findHubConsensusEnvDrift(
                { HUB_NETWORK: 'mainnet', XCHAIN_PRICE_WINDOW_BLOCKS: '99' },
                { HUB_NETWORK: 'mainnet', XCHAIN_PRICE_WINDOW_BLOCKS: '10' }
            )
            expect(drift).to.deep.equal([])
        })

        it('DOES flag a dropped override on a regtest venue, where the hub honors it', () => {
            const drift = findHubConsensusEnvDrift(
                { HUB_NETWORK: 'regtest' },
                { HUB_NETWORK: 'regtest', XCHAIN_PRICE_MIN_BTC_VOLUME: '0' }
            )
            expect(drift).to.deep.equal([{ key: 'XCHAIN_PRICE_MIN_BTC_VOLUME' }])
        })

        it('DOES flag a dropped override when only the RUNNING container says regtest', () => {
            // The shell lost HUB_NETWORK too; that is drift in its own right, and
            // the override it silently drops alongside must be named as well.
            const drift = findHubConsensusEnvDrift(
                {},
                { HUB_NETWORK: 'regtest', XCHAIN_PRICE_BOOTSTRAP_SATS: '5000' }
            )
            expect(drift.map(d => d.key).sort()).to.deep.equal(['HUB_NETWORK', 'XCHAIN_PRICE_BOOTSTRAP_SATS'])
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

        it('lets a mainnet recreate unset a stale, already-ignored derivation override', async () => {
            // End to end over the exact deploy the naive "just add the keys"
            // change would have refused forever.
            const drift = await assertNoHubConsensusEnvDrift(
                { HUB_NETWORK: 'mainnet' },
                {
                    execFileAsync: inspectStub({ HUB_NETWORK: 'mainnet', XCHAIN_PRICE_BOOTSTRAP_SATS: '5000' }),
                    env: {}
                }
            )
            expect(drift).to.deep.equal([])
        })

        it('still refuses a regtest recreate that would drop a honored derivation override', async () => {
            let thrown = null
            try {
                await assertNoHubConsensusEnvDrift(
                    { HUB_NETWORK: 'regtest' },
                    {
                        execFileAsync: inspectStub({ HUB_NETWORK: 'regtest', XCHAIN_PRICE_WINDOW_BLOCKS: '10' }),
                        env: {}
                    }
                )
            } catch (err) { thrown = err }
            expect(isHubConsensusEnvDriftError(thrown)).to.equal(true)
            expect(thrown.drift).to.deep.equal([{ key: 'XCHAIN_PRICE_WINDOW_BLOCKS' }])
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
