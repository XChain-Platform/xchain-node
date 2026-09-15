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
    sinon, expect, loadCredentialsService, makeFs
} = require('./helpers')

// loadExternalDbConfig
describe('CredentialsService', function () {

    describe('loadExternalDbConfig()', function () {

        it('returns the externalDb block when present', function () {
            const extDb = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' }
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ externalDb: extDb }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadExternalDbConfig()).to.deep.equal(extDb)
        })

        it('returns null when externalDb is absent', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({}))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadExternalDbConfig()).to.be.null
        })

        it('returns null when file cannot be parsed', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadExternalDbConfig()).to.be.null
        })
    })
})
