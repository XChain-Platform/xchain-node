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

// The shared hub account every co-located install provisions under its own prefix.
const HUB_USER = 'xchain_hub'

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

    describe('findHubDbCredentialDrift', () => {

        it('flags a sibling install whose hub carries a different shared password', () => {
            const { findHubDbCredentialDrift } = load()
            const drift = findHubDbCredentialDrift(
                { user: HUB_USER, pass: 'hpass' },
                [
                    { name: 'xchain-node-xchain-hub',  env: { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'hpass' } },
                    { name: 'scratch-clone-xchain-hub', env: { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'other' } }
                ]
            )
            expect(drift).to.have.length(1)
            expect(drift[0].container).to.equal('scratch-clone-xchain-hub')
            expect(drift[0].account).to.equal(HUB_USER)
        })

        // The indexer points HUB_DB_USER at its OWN account, so its differing
        // HUB_DB_PASS is not this account's and must not raise a refusal.
        it('does not flag an indexer whose hub connection uses its own account', () => {
            const { findHubDbCredentialDrift } = load()
            const drift = findHubDbCredentialDrift(
                { user: HUB_USER, pass: 'hpass' },
                [{
                    name: 'xchain-node-dogecoin-regtest-xchain-indexer',
                    env: { HUB_DB_USER: 'xchain_indexer_dogecoin_regtest', HUB_DB_PASS: 'ipass' }
                }]
            )
            expect(drift).to.deep.equal([])
        })

        it('treats an absent or empty value on either side as no claim', () => {
            const { findHubDbCredentialDrift } = load()
            const containers = [
                { name: 'no-pass',  env: { HUB_DB_USER: HUB_USER } },
                { name: 'empty',    env: { HUB_DB_USER: HUB_USER, HUB_DB_PASS: '' } },
                { name: 'no-user',  env: { HUB_DB_PASS: 'other' } }
            ]
            expect(findHubDbCredentialDrift({ user: HUB_USER, pass: 'hpass' }, containers)).to.deep.equal([])
            expect(findHubDbCredentialDrift({ user: HUB_USER }, [
                { name: 'live', env: { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'other' } }
            ])).to.deep.equal([])
            expect(findHubDbCredentialDrift(null, containers)).to.deep.equal([])
        })
    })
})
