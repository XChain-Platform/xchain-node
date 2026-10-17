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
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')

// Helpers

// Homedir used by tests (never the real home)
const FAKE_HOME = '/tmp/test-xchain-home'
const CREDS_DIR  = path.join(FAKE_HOME, '.xchain-node')
const CREDS_FILE = path.join(CREDS_DIR, 'credentials.json')

// Build a CredentialsService loaded with stubbed fs and os modules
function loadCredentialsService(fsStub, osStub) {
    return proxyquire('../../../../src/services/credentials_service', {
        'fs': fsStub,
        'os': osStub || { homedir: () => FAKE_HOME, userInfo: () => ({ username: 'testuser' }) }
    })
}

// Typical fs stub; all operations succeed by default
function makeFs(overrides = {}) {
    return {
        existsSync:    sinon.stub().returns(false),
        readFileSync:  sinon.stub().returns('{}'),
        writeFileSync: sinon.stub(),
        mkdirSync:     sinon.stub(),
        chmodSync:     sinon.stub(),
        // The atomic save: temp file, flush, rename over the original
        renameSync:    sinon.stub(),
        unlinkSync:    sinon.stub(),
        openSync:      sinon.stub().returns(42),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        ...overrides
    }
}

// An fs error carrying its code, the way node's fs raises one
function fsError(code) {
    return Object.assign(new Error(code), { code })
}

// Assert a save went through a flushed 0600 temp file renamed over credentials.json, and return what it wrote
function expectAtomicSave(fs) {
    expect(fs.writeFileSync.calledOnce).to.be.true
    const [tmpPath, content, opts] = fs.writeFileSync.firstCall.args
    expect(path.dirname(tmpPath)).to.equal(CREDS_DIR)
    expect(tmpPath).to.match(/\.tmp$/)
    expect(opts).to.include({ mode: 0o600, flag: 'wx' })
    expect(fs.fsyncSync.calledOnce).to.be.true
    const renameOver = fs.renameSync.getCalls().find(c => c.args[0] === tmpPath && c.args[1] === CREDS_FILE)
    expect(renameOver, 'the temp file is renamed over credentials.json').to.exist
    expect(renameOver.calledAfter(fs.fsyncSync.firstCall)).to.be.true
    return { content, opts }
}

module.exports = {
    sinon,
    expect,
    FAKE_HOME,
    CREDS_DIR,
    CREDS_FILE,
    loadCredentialsService,
    makeFs,
    fsError,
    expectAtomicSave
}
