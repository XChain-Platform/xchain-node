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

// saveExternalDbConfig
describe('CredentialsService', function () {

    describe('saveExternalDbConfig()', function () {

        it('creates dir if it does not exist', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(false),
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            })
            const cs = loadCredentialsService(fs)
            const cfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' }
            cs.saveExternalDbConfig(cfg)
            expect(fs.mkdirSync.calledOnce).to.be.true
        })

        it('merges externalDb into existing credentials.json', function () {
            const existingCreds = { user: 'u', password: 'test-pass', database: 'xchain_node' }
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify(existingCreds))
            })
            const cs = loadCredentialsService(fs)
            const cfg = { host: 'db.host', port: 5506, root_user: 'admin', root_password: 'test-root-pass' }
            cs.saveExternalDbConfig(cfg)

            const [, written] = fs.writeFileSync.firstCall.args
            const parsed = JSON.parse(written)
            // Original fields preserved
            expect(parsed.user).to.equal('u')
            expect(parsed.password).to.equal('test-pass')
            // externalDb merged in
            expect(parsed.externalDb.host).to.equal('db.host')
            expect(parsed.externalDb.port).to.equal(5506)
            expect(parsed.externalDb.root_user).to.equal('admin')
            expect(parsed.externalDb.root_password).to.equal('test-root-pass')
        })
    })
})

describe('CredentialsService', function () {

    describe('saveExternalDbConfig()', function () {

        it('coerces types: host/root_user/root_password to string, port to number', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            })
            const cs = loadCredentialsService(fs)
            cs.saveExternalDbConfig({ host: 127, port: '3306', root_user: 42, root_password: true })
            const [, written] = fs.writeFileSync.firstCall.args
            const parsed = JSON.parse(written)
            expect(parsed.externalDb.host).to.equal('127')
            expect(parsed.externalDb.port).to.equal(3306)
            expect(parsed.externalDb.root_user).to.equal('42')
            expect(parsed.externalDb.root_password).to.equal('true')
        })

        it('writes file with mode 0600', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(true) })
            const cs = loadCredentialsService(fs)
            cs.saveExternalDbConfig({ host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' })
            const [, , opts] = fs.writeFileSync.firstCall.args
            expect(opts.mode).to.equal(0o600)
        })

        it('silently ignores chmodSync errors', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                chmodSync: sinon.stub().throws(new Error('EPERM'))
            })
            const cs = loadCredentialsService(fs)
            expect(() => cs.saveExternalDbConfig({
                host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass'
            })).to.not.throw()
        })
    })
})
