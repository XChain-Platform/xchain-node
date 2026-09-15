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

const { configStub } = require('../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const DECODER = 'xchain-decoder'
const INDEXER = 'xchain-indexer'
const HUB     = 'xchain-hub'

function load() {
    return proxyquire('../../src/services/db_credential_drift', {
        '../config': configStub({
            XChainService: { XCHAIN_DECODER: DECODER, XCHAIN_INDEXER: INDEXER },
            HUB_MODULE_NAME: HUB
        }),
        './config_service': {
            getDockerContainerImageName: (mod, coin, net) => `xchain-node-${coin}-${net}-${mod}`
        }
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
    })

    describe('findDbCredentialDrift', () => {

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
})
