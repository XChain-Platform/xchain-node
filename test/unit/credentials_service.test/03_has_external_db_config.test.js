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

// hasExternalDbConfig
describe('CredentialsService', function () {

    describe('hasExternalDbConfig()', function () {

        it('returns true when credentials.json has a well-formed externalDb block', function () {
            const extDb = {
                host: '127.0.0.1',
                port: 3306,
                root_user: 'root',
                root_password: 'test-pass'
            }
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ externalDb: extDb }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.true
        })

        it('returns false when externalDb block is absent', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ user: 'u', password: 'p' }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.false
        })

        it('returns false when host is not a string', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({
                    externalDb: { host: 123, port: 3306, root_user: 'root', root_password: 'p' }
                }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.false
        })

        it('returns false when port is not a number', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({
                    externalDb: { host: '127.0.0.1', port: '3306', root_user: 'root', root_password: 'p' }
                }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.false
        })
    })
})

describe('CredentialsService', function () {

    describe('hasExternalDbConfig()', function () {

        it('returns false when root_user is not a string', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({
                    externalDb: { host: '127.0.0.1', port: 3306, root_user: null, root_password: 'p' }
                }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.false
        })

        it('returns false when root_password is not a string', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({
                    externalDb: { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: undefined }
                }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.false
        })

        it('returns false when readFileSync throws', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasExternalDbConfig()).to.be.false
        })
    })
})
