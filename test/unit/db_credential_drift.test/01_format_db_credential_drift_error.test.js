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

describe('DbCredentialDrift', () => {

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
})
