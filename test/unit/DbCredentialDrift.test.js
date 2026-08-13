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

const DECODER = 'xchain-decoder'
const INDEXER = 'xchain-indexer'

function load() {
    return proxyquire('../../src/services/DbCredentialDrift', {
        '../config/constants': {
            XChainService: { XCHAIN_DECODER: DECODER, XCHAIN_INDEXER: INDEXER }
        },
        './ConfigService': {
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

    describe('findDbCredentialDrift', () => {

        it('reports nothing when every container carries the intended password', () => {
            const { findDbCredentialDrift } = load()
            const drift = findDbCredentialDrift(
                { decoder: 'dpass', indexer: 'ipass' },
                [
                    { module: DECODER, name: 'dec', env: { DECODER_DB_PASS: 'dpass' } },
                    { module: INDEXER, name: 'idx', env: { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'ipass' } }
                ]
            )
            expect(drift).to.deep.equal([])
        })

        //  exactly: the decoder was rebuilt from one install's config and the
        // indexer still ran with another's, so rotating the shared decoder account
        // locked the indexer out of BOTH databases it opens.
        it('flags an indexer built from another install on both accounts', () => {
            const { findDbCredentialDrift } = load()
            const drift = findDbCredentialDrift(
                { decoder: 'dpass-new', indexer: 'ipass-new' },
                [
                    { module: DECODER, name: 'dec', env: { DECODER_DB_PASS: 'dpass-new' } },
                    { module: INDEXER, name: 'idx', env: { DECODER_DB_PASS: 'dpass-old', INDEXER_DB_PASS: 'ipass-old' } }
                ]
            )
            expect(drift.map(d => d.envKey).sort()).to.deep.equal(['DECODER_DB_PASS', 'INDEXER_DB_PASS'])
            expect(drift.every(d => d.container === 'idx')).to.equal(true)
        })

        it('flags a decoder that disagrees on the shared decoder account', () => {
            const { findDbCredentialDrift } = load()
            const drift = findDbCredentialDrift(
                { decoder: 'dpass-new', indexer: 'ipass' },
                [{ module: DECODER, name: 'dec', env: { DECODER_DB_PASS: 'dpass-old' } }]
            )
            expect(drift).to.have.length(1)
            expect(drift[0]).to.include({ container: 'dec', envKey: 'DECODER_DB_PASS', account: 'decoder' })
        })

        // The decoder container carries INDEXER_DB_PASS in its env but never
        // authenticates with it, so a mismatch there is not a lockout and must not
        // block a legitimate rotation.
        it('ignores env keys the module does not authenticate with', () => {
            const { findDbCredentialDrift } = load()
            const drift = findDbCredentialDrift(
                { decoder: 'dpass', indexer: 'ipass-new' },
                [{ module: DECODER, name: 'dec', env: { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'ipass-old' } }]
            )
            expect(drift).to.deep.equal([])
        })

        it('ignores a key absent from either side', () => {
            const { findDbCredentialDrift } = load()
            expect(findDbCredentialDrift(
                { decoder: 'dpass' },
                [{ module: INDEXER, name: 'idx', env: { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'whatever' } }]
            )).to.deep.equal([])
            expect(findDbCredentialDrift(
                { decoder: 'dpass', indexer: 'ipass' },
                [{ module: INDEXER, name: 'idx', env: { DECODER_DB_PASS: 'dpass' } }]
            )).to.deep.equal([])
        })

        it('treats an empty intended value as no claim rather than as a mismatch', () => {
            const { findDbCredentialDrift } = load()
            const drift = findDbCredentialDrift(
                { decoder: '', indexer: 'ipass' },
                [{ module: INDEXER, name: 'idx', env: { DECODER_DB_PASS: 'dpass', INDEXER_DB_PASS: 'ipass' } }]
            )
            expect(drift).to.deep.equal([])
        })

        it('handles an empty container list and a missing intended map', () => {
            const { findDbCredentialDrift } = load()
            expect(findDbCredentialDrift({ decoder: 'd' }, [])).to.deep.equal([])
            expect(findDbCredentialDrift(undefined, [{ module: INDEXER, name: 'i', env: { INDEXER_DB_PASS: 'x' } }])).to.deep.equal([])
        })
    })

    describe('formatDbCredentialDriftError', () => {

        it('names the container and the remediation but never a password', () => {
            const { formatDbCredentialDriftError } = load()
            const message = formatDbCredentialDriftError('dogecoin', 'regtest', [
                { container: 'xchain-node-dogecoin-regtest-xchain-indexer', module: INDEXER, envKey: 'DECODER_DB_PASS', account: 'decoder' }
            ])
            expect(message).to.contain('xchain-node-dogecoin-regtest-xchain-indexer')
            expect(message).to.contain('recreate xchain-indexer dogecoin regtest')
            expect(message).to.contain('config/dogecoin-regtest')
            expect(message).to.contain('Nothing has been changed')
        })

        it('leaks no credential value into the message', () => {
            const { formatDbCredentialDriftError, findDbCredentialDrift } = load()
            const secret = 'e6f1a9c0deadbeefe6f1a9c0deadbeef'
            const drift = findDbCredentialDrift(
                { decoder: 'intended-value', indexer: 'ipass' },
                [{ module: DECODER, name: 'dec', env: { DECODER_DB_PASS: secret } }]
            )
            const message = formatDbCredentialDriftError('litecoin', 'regtest', drift)
            expect(message).to.not.contain(secret)
            expect(message).to.not.contain('intended-value')
        })
    })

    describe('readContainerEnv', () => {

        it('parses docker inspect output into a plain object', async () => {
            const { readContainerEnv } = load()
            const execFileAsync = inspectStub({ dec: { A: '1', DECODER_DB_PASS: 'x=y' } })
            const env = await readContainerEnv('dec', { execFileAsync })
            expect(env).to.deep.equal({ A: '1', DECODER_DB_PASS: 'x=y' })
        })

        it('returns null for a container that does not exist', async () => {
            const { readContainerEnv } = load()
            const env = await readContainerEnv('missing', { execFileAsync: inspectStub({}) })
            expect(env).to.equal(null)
        })

        it('returns null on unparseable output rather than throwing', async () => {
            const { readContainerEnv } = load()
            const execFileAsync = sinon.stub().resolves({ stdout: 'not json' })
            expect(await readContainerEnv('dec', { execFileAsync })).to.equal(null)
        })
    })

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

    describe('isDbCredentialDriftError', () => {

        it('separates the drift refusal from an unrelated failure', () => {
            const { isDbCredentialDriftError, DRIFT_ERROR_CODE } = load()
            const drift = new Error('locked out')
            drift.code = DRIFT_ERROR_CODE
            expect(isDbCredentialDriftError(drift)).to.equal(true)
            expect(isDbCredentialDriftError(new Error('docker network failure'))).to.equal(false)
            expect(isDbCredentialDriftError(null)).to.equal(false)
            expect(isDbCredentialDriftError('a string throw')).to.equal(false)
        })
    })
})
