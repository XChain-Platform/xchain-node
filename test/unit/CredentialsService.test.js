'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const os         = require('os')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Homedir used by tests — never the real home
const FAKE_HOME = '/tmp/test-xchain-home'
const CREDS_DIR  = path.join(FAKE_HOME, '.xchain-node')
const CREDS_FILE = path.join(CREDS_DIR, 'credentials.json')

// Build a CredentialsService loaded with stubbed fs and os modules
function loadCredentialsService(fsStub, osStub) {
    return proxyquire('../../src/services/CredentialsService', {
        'fs': fsStub,
        'os': osStub || { homedir: () => FAKE_HOME, userInfo: () => ({ username: 'testuser' }) }
    })
}

// Typical fs stub — all operations succeed by default
function makeFs(overrides = {}) {
    return {
        existsSync:    sinon.stub().returns(false),
        readFileSync:  sinon.stub().returns('{}'),
        writeFileSync: sinon.stub(),
        mkdirSync:     sinon.stub(),
        chmodSync:     sinon.stub(),
        ...overrides
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialsService', function () {

    // -------------------------------------------------------------------
    // Path helpers
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // sanitizeForMariaDb
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // getOsUserDbName
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // generatePassword
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // hasCredentials
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // loadCredentials
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // saveCredentials
    // -------------------------------------------------------------------

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
    })

    // -------------------------------------------------------------------
    // hasExternalDbConfig
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // loadExternalDbConfig
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // saveExternalDbConfig
    // -------------------------------------------------------------------

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

    // -------------------------------------------------------------------
    // XCHAIN_NODE_DB constant
    // -------------------------------------------------------------------

    describe('XCHAIN_NODE_DB', function () {

        it('equals "xchain_node"', function () {
            const cs = loadCredentialsService(makeFs())
            expect(cs.XCHAIN_NODE_DB).to.equal('xchain_node')
        })
    })
})
