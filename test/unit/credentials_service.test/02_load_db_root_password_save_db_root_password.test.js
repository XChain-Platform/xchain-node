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
    sinon, expect, CREDS_FILE,
    loadCredentialsService, makeFs
} = require('./support/helpers')

// loadDbRootPassword / saveDbRootPassword
describe('CredentialsService', function () {

    describe('loadDbRootPassword() / saveDbRootPassword()', function () {

        it('loadDbRootPassword returns null when the file or key is absent', function () {
            const noFile = loadCredentialsService(makeFs({
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            }))
            expect(noFile.loadDbRootPassword()).to.be.null

            const noKey = loadCredentialsService(makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ user: 'u', password: 'p' }))
            }))
            expect(noKey.loadDbRootPassword()).to.be.null
        })

        it('loadDbRootPassword returns the stored value and rejects non-string/empty shapes', function () {
            const stored = loadCredentialsService(makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ dbRootPassword: 'root-pw' }))
            }))
            expect(stored.loadDbRootPassword()).to.equal('root-pw')

            const empty = loadCredentialsService(makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ dbRootPassword: '' }))
            }))
            expect(empty.loadDbRootPassword()).to.be.null

            const wrongType = loadCredentialsService(makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ dbRootPassword: 42 }))
            }))
            expect(wrongType.loadDbRootPassword()).to.be.null
        })
    })
})

describe('CredentialsService', function () {

    describe('loadDbRootPassword() / saveDbRootPassword()', function () {

        it('saveDbRootPassword read-modify-writes with mode 0600, preserving sibling keys', function () {
            const existingContent = JSON.stringify({
                user: 'u', password: 'p', database: 'xchain_node',
                externalDb: { host: 'db.example.com', port: 3306, root_user: 'root', root_password: 'r' }
            })
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(existingContent)
            })
            const cs = loadCredentialsService(fs)
            cs.saveDbRootPassword('new-root-pw')

            expect(fs.writeFileSync.calledOnce).to.be.true
            const [filePath, content, opts] = fs.writeFileSync.firstCall.args
            expect(filePath).to.equal(CREDS_FILE)
            const written = JSON.parse(content)
            expect(written.dbRootPassword).to.equal('new-root-pw')
            expect(written.user).to.equal('u')
            expect(written.externalDb.host).to.equal('db.example.com')
            expect(opts.mode).to.equal(0o600)
            expect(fs.chmodSync.calledWith(CREDS_FILE, 0o600)).to.be.true
        })

        it('saveDbRootPassword creates the 0700 dir when missing', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(false) })
            const cs = loadCredentialsService(fs)
            cs.saveDbRootPassword('pw')
            expect(fs.mkdirSync.calledOnce).to.be.true
            expect(fs.mkdirSync.firstCall.args[1]).to.deep.equal({ recursive: true, mode: 0o700 })
        })
    })
})
