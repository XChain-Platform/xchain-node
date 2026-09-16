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

const { makeConfigService, makeServiceWithConfig } = require('./support/helpers')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] Config Parsing Boundaries', function () {

        it('R-BND-001: config values containing "=" are preserved fully', async function () {
            const cs = makeServiceWithConfig('NODE_PASSWORD=p@ss=word=123\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('p@ss=word=123')
        })

        it('R-BND-002: base64 values with trailing "=" are preserved', async function () {
            const cs = makeServiceWithConfig('AUTH_TOKEN=dGVzdA==\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['AUTH_TOKEN']).to.equal('dGVzdA==')
        })

        it('R-BND-003: empty value after "=" is preserved as empty string', async function () {
            const cs = makeServiceWithConfig('EMPTY_VAR=\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['EMPTY_VAR']).to.equal('')
        })

        it('R-BND-004: blank lines and lines without "=" are skipped', async function () {
            const cs = makeServiceWithConfig('\n\nno-equals-here\nKEY=value\n\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['no-equals-here']).to.be.undefined
            expect(config['KEY']).to.equal('value')
        })

        it('R-BND-005: missing config file falls back to defaults', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                // getDefaultConfig now persists generated RPC creds to the
                // .local sidecar (6648722): persistSidecarCreds needs these.
                writeFileSync: sinon.stub(),
                appendFileSync: sinon.stub(),
                chmodSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            // Should still have default values
            expect(config['NODE_PORT']).to.equal(8332)
            expect(config['ENCODER_API_PORT']).to.equal(3003)
        })
    })
})
