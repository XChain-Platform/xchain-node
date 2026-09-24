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
    sinon, expect, makeMemoryConfigService, CONTAINER_ID, coinSidecar, hubSidecar
} = require('./helpers.test')

describe('ConfigService', function () {
    describe('preferred (_SECRET) sidecar names', function () {

        it('a fresh coin/network sidecar writes RPC and DB credentials under their redaction-safe _SECRET names', async function () {
            const { cs, files } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
            await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            const coinBody = files[coinSidecar] || ''
            expect(coinBody).to.include('NODE_SECRET=')
            expect(coinBody).to.include('DECODER_DB_SECRET=')
            expect(coinBody).to.include('INDEXER_DB_SECRET=')
            expect(coinBody).to.not.include('NODE_PASSWORD=')
            expect(coinBody).to.not.include('DECODER_DB_PASS=')
            expect(coinBody).to.not.include('INDEXER_DB_PASS=')
            const hubBody = files[hubSidecar] || ''
            expect(hubBody).to.include('HUB_DB_SECRET=')
            expect(hubBody).to.not.include('HUB_DB_PASS=')
        })

        it('a reload of a freshly-generated sidecar resolves the same credentials without regenerating them', async function () {
            const { cs } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
            const first  = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            const second = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            expect(second['NODE_PASSWORD']).to.equal(first['NODE_PASSWORD'])
            expect(second['DECODER_DB_PASS']).to.equal(first['DECODER_DB_PASS'])
            expect(second['INDEXER_DB_PASS']).to.equal(first['INDEXER_DB_PASS'])
        })

        it('a full install (generate) plus reload emits no deprecated-name warning', async function () {
            // getDefaultConfig also warns when the main config file is absent (an
            // unrelated, expected notice on a from-scratch install); only the
            // deprecated-secret-name warning is what this rename was meant to silence.
            const { cs } = makeMemoryConfigService({}, { dbContainerId: CONTAINER_ID })
            const warnSpy = sinon.stub(console, 'warn')
            try {
                await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
                await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            } finally {
                warnSpy.restore()
            }
            const deprecatedWarnings = warnSpy.args.filter(args => String(args[0]).includes('deprecated name'))
            expect(deprecatedWarnings).to.deep.equal([])
        })

        it('still warns when an existing sidecar carries a deprecated legacy name', async function () {
            const { cs } = makeMemoryConfigService({
                [coinSidecar]: 'NODE_USER=u\nNODE_PASSWORD=legacypass\n'
            })
            const warnSpy = sinon.stub(console, 'warn')
            try {
                await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            } finally {
                warnSpy.restore()
            }
            expect(warnSpy.called).to.equal(true)
            expect(warnSpy.args.some(args => String(args[0]).includes('NODE_PASSWORD'))).to.equal(true)
        })

        it('legacy fallback: an existing old-name sidecar still resolves and is not force-renamed', async function () {
            const { cs, files } = makeMemoryConfigService({
                [coinSidecar]: 'NODE_USER=u\nNODE_PASSWORD=legacypass\n'
            })
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('legacypass')
            expect(config['NODE_USER']).to.equal('u')
            expect(files[coinSidecar]).to.include('NODE_PASSWORD=legacypass')
            expect(files[coinSidecar]).to.not.include('NODE_SECRET=')
        })

        it('a rotation on a sidecar already using the new name does not reintroduce the legacy twin', async function () {
            const { cs, files } = makeMemoryConfigService({
                [coinSidecar]: 'NODE_USER=u\nNODE_SECRET=n\nDECODER_DB_SECRET=d\nINDEXER_DB_SECRET=i\n'
            }, { dbContainerId: CONTAINER_ID })
            const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('n')
            expect(config['DECODER_DB_PASS']).to.equal('d')
            const body = files[coinSidecar] || ''
            expect(body).to.not.include('NODE_PASSWORD=')
            expect(body).to.not.include('DECODER_DB_PASS=')
            expect(body).to.not.include('INDEXER_DB_PASS=')
        })
    })
})
