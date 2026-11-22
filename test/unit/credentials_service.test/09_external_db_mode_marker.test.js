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
    sinon, expect, loadCredentialsService, makeFs, fsError, expectAtomicSave
} = require('./support/helpers')

const EXTERNAL_BLOCK = { host: 'db.host', port: 3306, root_user: 'root', root_password: 'test-root-pass' }

function fsHolding(doc) {
    return makeFs({
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().returns(JSON.stringify(doc))
    })
}

function registerMarkCases() {
    it('writes a secret-free marker and keeps the other keys', function () {
        const fs = fsHolding({ user: 'u', password: 'test-pass', externalDb: EXTERNAL_BLOCK })
        loadCredentialsService(fs).markExternalDbMode()
        const parsed = JSON.parse(expectAtomicSave(fs).content)
        expect(parsed.externalDbMode).to.equal(true)
        expect(parsed.user).to.equal('u')
        expect(parsed.externalDb).to.deep.equal(EXTERNAL_BLOCK)
    })

    it('creates the file when none exists', function () {
        const fs = makeFs({
            existsSync: sinon.stub().returns(false),
            readFileSync: sinon.stub().throws(fsError('ENOENT'))
        })
        loadCredentialsService(fs).markExternalDbMode()
        expect(JSON.parse(expectAtomicSave(fs).content)).to.deep.equal({ externalDbMode: true })
        expect(fs.mkdirSync.calledOnce).to.equal(true)
    })

    it('does not rewrite the file when the marker is already set', function () {
        const fs = fsHolding({ externalDbMode: true })
        loadCredentialsService(fs).markExternalDbMode()
        expect(fs.writeFileSync.called).to.equal(false)
    })

    it('keeps the marker through a later saveExternalDbConfig and saveCredentials', function () {
        const fs = fsHolding({ externalDbMode: true })
        const cs = loadCredentialsService(fs)
        cs.saveExternalDbConfig(EXTERNAL_BLOCK)
        expect(JSON.parse(fs.writeFileSync.firstCall.args[1]).externalDbMode).to.equal(true)
        cs.saveCredentials({ user: 'u', password: 'test-pass' })
        expect(JSON.parse(fs.writeFileSync.secondCall.args[1]).externalDbMode).to.equal(true)
    })
}

function registerKnownHostCases() {
    it('is true for the marker alone, with no externalDb block', function () {
        expect(loadCredentialsService(fsHolding({ externalDbMode: true })).isKnownExternalDbHost()).to.equal(true)
    })

    it('is true for a complete externalDb block', function () {
        expect(loadCredentialsService(fsHolding({ externalDb: EXTERNAL_BLOCK })).isKnownExternalDbHost()).to.equal(true)
    })

    it('is true for a partial externalDb block', function () {
        expect(loadCredentialsService(fsHolding({ externalDb: { host: 'db.host' } })).isKnownExternalDbHost()).to.equal(true)
    })

    it('is false for a bundled-mode file, a missing file and an unparseable file', function () {
        expect(loadCredentialsService(fsHolding({ user: 'u', password: 'test-pass' })).isKnownExternalDbHost()).to.equal(false)
        const missing = makeFs({ readFileSync: sinon.stub().throws(fsError('ENOENT')) })
        expect(loadCredentialsService(missing).isKnownExternalDbHost()).to.equal(false)
        const garbled = makeFs({ readFileSync: sinon.stub().returns('{not json') })
        expect(loadCredentialsService(garbled).isKnownExternalDbHost()).to.equal(false)
    })

    it('is false when the marker is not literally true', function () {
        expect(loadCredentialsService(fsHolding({ externalDbMode: 'yes' })).isKnownExternalDbHost()).to.equal(false)
    })
}

describe('CredentialsService', function () {
    describe('markExternalDbMode()', registerMarkCases)
    describe('isKnownExternalDbHost()', registerKnownHostCases)
})
