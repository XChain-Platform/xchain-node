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
    sinon, expect, CREDS_DIR, CREDS_FILE,
    loadCredentialsService, makeFs
} = require('./support/helpers')

// saveCredentials
describe('CredentialsService', function () {

    describe('saveCredentials()', function () {

        it('creates dir if it does not exist', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(false)
            })
            const cs = loadCredentialsService(fs)
            cs.saveCredentials({ user: 'u', password: 'test-pass', database: 'xchain_node' })
            expect(fs.mkdirSync.calledOnce).to.be.true
            expect(fs.mkdirSync.firstCall.args[0]).to.equal(CREDS_DIR)
            expect(fs.mkdirSync.firstCall.args[1]).to.deep.equal({ recursive: true, mode: 0o700 })
        })

        it('does not create dir when it already exists', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(true)
            })
            const cs = loadCredentialsService(fs)
            cs.saveCredentials({ user: 'u', password: 'test-pass', database: 'xchain_node' })
            expect(fs.mkdirSync.called).to.be.false
        })

        it('writes JSON to credentials file with mode 0600', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(true)
            })
            const cs = loadCredentialsService(fs)
            const creds = { user: 'u', password: 'test-pass', database: 'xchain_node' }
            cs.saveCredentials(creds)
            expect(fs.writeFileSync.calledOnce).to.be.true
            const [filePath, content, opts] = fs.writeFileSync.firstCall.args
            expect(filePath).to.equal(CREDS_FILE)
            expect(JSON.parse(content)).to.deep.equal(creds)
            expect(opts.mode).to.equal(0o600)
        })
    })
})

describe('CredentialsService', function () {

    describe('saveCredentials()', function () {

        it('calls chmodSync on file after writing', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(true) })
            const cs = loadCredentialsService(fs)
            cs.saveCredentials({ user: 'u', password: 'test-pass', database: 'xchain_node' })
            expect(fs.chmodSync.calledWith(CREDS_FILE, 0o600)).to.be.true
        })

        it('silently ignores chmodSync errors (Windows compat)', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                chmodSync: sinon.stub().throws(new Error('EPERM'))
            })
            const cs = loadCredentialsService(fs)
            // Should not throw
            expect(() => cs.saveCredentials({ user: 'u', password: 'test-pass', database: 'xchain_node' })).to.not.throw()
        })

        // saveCredentials() reads and merges the existing document before writing.
        // Replacing credentials.json wholesale destroys sibling keys, notably the
        // externalDb block that saveExternalDbConfig() stores during the same
        // provisioning run. The read-modify-write flow preserves that sibling
        // configuration while updating the primary credentials.
        it('preserves the externalDb block written by saveExternalDbConfig', function () {
            const existingContent = JSON.stringify({
                externalDb: { host: 'db.example.com', port: 3306, root_user: 'root', root_password: 'r' }
            })
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(existingContent)
            })
            const cs = loadCredentialsService(fs)
            cs.saveCredentials({ user: 'u', password: 'test-pass', database: 'xchain_node' })

            expect(fs.writeFileSync.calledOnce).to.be.true
            const [filePath, content, opts] = fs.writeFileSync.firstCall.args
            expect(filePath).to.equal(CREDS_FILE)
            const written = JSON.parse(content)
            expect(written.externalDb).to.deep.equal({ host: 'db.example.com', port: 3306, root_user: 'root', root_password: 'r' })
            expect(written.user).to.equal('u')
            expect(written.password).to.equal('test-pass')
            expect(written.database).to.equal('xchain_node')
            expect(opts.mode).to.equal(0o600)
        })
    })
})
