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
    sinon, expect, FAKE_HOME, CREDS_DIR, CREDS_FILE,
    loadCredentialsService, makeFs
} = require('./credentials_service.test/helpers')

// Tests
describe('CredentialsService', function () {

    // Path helpers
    describe('getCredentialsDir()', function () {

        it('returns ~/.xchain-node', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.getCredentialsDir()).to.equal(CREDS_DIR)
        })
    })

    describe('getCredentialsPath()', function () {

        it('returns ~/.xchain-node/credentials.json', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.getCredentialsPath()).to.equal(CREDS_FILE)
        })
    })
})

// sanitizeForMariaDb
describe('CredentialsService', function () {

    describe('sanitizeForMariaDb()', function () {

        it('passes through alphanumeric + underscore unchanged', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.sanitizeForMariaDb('hello_World123')).to.equal('hello_World123')
        })

        it('replaces hyphens and spaces with underscores', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.sanitizeForMariaDb('my-user name')).to.equal('my_user_name')
        })

        it('replaces all special chars with underscores', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.sanitizeForMariaDb('user@host.com')).to.equal('user_host_com')
        })

        it('replaces non-alphanumeric chars (including !) with underscores', function () {
            const cs = loadCredentialsService(makeFs())
            // Source replaces non-[a-zA-Z0-9_] with '_', so '!!!' → '___' (non-empty → returned as-is)
            expect(cs.sanitizeForMariaDb('!!!')).to.equal('___')
        })

        it('returns "user" for empty input (zero-length cleaned string)', function () {
            const cs = loadCredentialsService(makeFs())
            // Empty string → cleaned is '' → length 0 → return 'user'
            expect(cs.sanitizeForMariaDb('')).to.equal('user')
        })
    })
})

// getOsUserDbName
describe('CredentialsService', function () {

    describe('getOsUserDbName()', function () {

        it('returns xchain_node_<sanitized-username>', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.getOsUserDbName()).to.equal('xchain_node_testuser')
        })

        it('sanitizes username with special chars', function () {
            const cs = loadCredentialsService(makeFs(), {
                homedir: () => FAKE_HOME,
                userInfo: () => ({ username: 'my-user@domain' })
            })
            expect(cs.getOsUserDbName()).to.equal('xchain_node_my_user_domain')
        })

        it('truncates username at 60 chars', function () {
            const longUser = 'a'.repeat(70)
            const cs = loadCredentialsService(makeFs(), {
                homedir: () => FAKE_HOME,
                userInfo: () => ({ username: longUser })
            })
            const name = cs.getOsUserDbName()
            // 'xchain_node_' prefix + 60 char user part
            expect(name).to.equal('xchain_node_' + 'a'.repeat(60))
        })
    })
})

// generatePassword
describe('CredentialsService', function () {

    describe('generatePassword()', function () {

        it('returns a non-empty base64url string', function () {
            const cs = loadCredentialsService(makeFs())
            const pwd = cs.generatePassword()
            expect(pwd).to.be.a('string').with.length.greaterThan(0)
            // base64url chars only
            expect(pwd).to.match(/^[A-Za-z0-9_-]+$/)
        })

        it('returns different values on successive calls', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.generatePassword()).to.not.equal(cs.generatePassword())
        })

        it('accepts custom byte length', function () {
            const cs = loadCredentialsService(makeFs())
            // 16 bytes → ~22 base64url chars
            const pwd = cs.generatePassword(16)
            expect(pwd.length).to.be.greaterThan(0)
        })
    })
})

// hasCredentials
describe('CredentialsService', function () {

    describe('hasCredentials()', function () {

        it('returns true when credentials file exists', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(true) })
            const cs = loadCredentialsService(fs)
            expect(cs.hasCredentials()).to.be.true
        })

        it('returns false when file does not exist', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(false) })
            const cs = loadCredentialsService(fs)
            expect(cs.hasCredentials()).to.be.false
        })

        it('returns false when existsSync throws', function () {
            const fs = makeFs({
                existsSync: sinon.stub().throws(new Error('EPERM'))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.hasCredentials()).to.be.false
        })
    })
})

// loadCredentials
describe('CredentialsService', function () {

    describe('loadCredentials()', function () {

        it('returns parsed object with user and password', function () {
            const creds = { user: 'xchain_node_testuser', password: 'test-pass', database: 'xchain_node' }
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify(creds))
            })
            const cs = loadCredentialsService(fs)
            const result = cs.loadCredentials()
            expect(result).to.deep.equal(creds)
        })

        it('returns null when file is not valid JSON', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns('not-json')
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadCredentials()).to.be.null
        })

        it('returns null when parsed object is missing user field', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ password: 'pw' }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadCredentials()).to.be.null
        })

        it('returns null when parsed object is missing password field', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns(JSON.stringify({ user: 'u' }))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadCredentials()).to.be.null
        })

        it('returns null when readFileSync throws', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().throws(new Error('ENOENT'))
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadCredentials()).to.be.null
        })

        it('returns null when file contains null', function () {
            const fs = makeFs({
                readFileSync: sinon.stub().returns('null')
            })
            const cs = loadCredentialsService(fs)
            expect(cs.loadCredentials()).to.be.null
        })
    })
})
