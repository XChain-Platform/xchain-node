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
