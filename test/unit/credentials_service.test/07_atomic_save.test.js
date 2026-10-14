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

// Pins the save path of credentials.json: never truncated in place, and an existing file that
// will not parse is moved aside, not silently rebuilt from {} with its sibling blocks dropped.

const {
    sinon, expect, CREDS_DIR, CREDS_FILE,
    loadCredentialsService, makeFs, fsError, expectAtomicSave
} = require('./support/helpers')

const TORN = '{"user":"u","password":"s3cret-torn'

// The three save helpers, each with the one field it writes.
const SAVES = [
    { name: 'saveCredentials', run: cs => cs.saveCredentials({ user: 'n', password: 'np' }), field: { user: 'n', password: 'np' } },
    { name: 'saveDbRootPassword', run: cs => cs.saveDbRootPassword('rootpw'), field: { dbRootPassword: 'rootpw' } },
    {
        name: 'saveExternalDbConfig',
        run: cs => cs.saveExternalDbConfig({ host: 'h', port: 3306, root_user: 'r', root_password: 'rp' }),
        field: { externalDb: { host: 'h', port: 3306, root_user: 'r', root_password: 'rp' } }
    }
]

let warnStub

describe('CredentialsService', function () {
    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => warnStub.restore())

    describe('atomic save of an unparseable credentials.json', function () {
        for (const save of SAVES) {
            it(`${save.name} moves a torn file aside, warns without secrets, and saves only its own field`, function () {
                const fs = makeFs({ existsSync: sinon.stub().returns(true), readFileSync: sinon.stub().returns(TORN) })
                save.run(loadCredentialsService(fs))
                const aside = fs.renameSync.firstCall.args
                expect(aside[0]).to.equal(CREDS_FILE)
                expect(aside[1].startsWith(CREDS_FILE + '.corrupt-')).to.be.true
                expect(warnStub.calledOnce).to.be.true
                expect(String(warnStub.firstCall.args[0])).to.include(aside[1])
                expect(String(warnStub.firstCall.args[0])).to.not.include('s3cret')
                const { content } = expectAtomicSave(fs)
                expect(JSON.parse(content)).to.deep.equal(save.field)
            })
        }

        it('treats a document that parses to something other than an object as unparseable', function () {
            for (const body of ['null', '[]', '"text"', '7']) {
                const fs = makeFs({ existsSync: sinon.stub().returns(true), readFileSync: sinon.stub().returns(body) })
                loadCredentialsService(fs).saveDbRootPassword('pw')
                expect(fs.renameSync.firstCall.args[1].startsWith(CREDS_FILE + '.corrupt-'), body).to.be.true
            }
        })

        it('refuses to save when the torn file cannot be moved aside, leaving it in place', function () {
            const fs = makeFs({
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(TORN),
                renameSync: sinon.stub().throws(fsError('EXDEV'))
            })
            expect(() => loadCredentialsService(fs).saveDbRootPassword('pw')).to.throw('EXDEV')
            expect(fs.writeFileSync.called).to.be.false
        })
    })
})

describe('CredentialsService', function () {
    beforeEach(() => { warnStub = sinon.stub(console, 'warn') })
    afterEach(() => warnStub.restore())

    describe('atomic save read and write failures', function () {
        it('starts a fresh document, with nothing moved aside, when the file does not exist', function () {
            const fs = makeFs({ readFileSync: sinon.stub().throws(fsError('ENOENT')) })
            loadCredentialsService(fs).saveDbRootPassword('pw')
            const { content } = expectAtomicSave(fs)
            expect(JSON.parse(content)).to.deep.equal({ dbRootPassword: 'pw' })
            expect(fs.renameSync.calledOnce).to.be.true
            expect(warnStub.called).to.be.false
        })

        it('refuses to save over a file it cannot read, rather than replacing it by rename', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(true), readFileSync: sinon.stub().throws(fsError('EACCES')) })
            expect(() => loadCredentialsService(fs).saveDbRootPassword('pw')).to.throw('EACCES')
            expect(fs.writeFileSync.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })

        it('leaves credentials.json untouched and removes the temp file when the write fails', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(true), writeFileSync: sinon.stub().throws(fsError('ENOSPC')) })
            expect(() => loadCredentialsService(fs).saveDbRootPassword('pw')).to.throw('ENOSPC')
            const tmpPath = fs.writeFileSync.firstCall.args[0]
            expect(tmpPath.startsWith(CREDS_DIR)).to.be.true
            expect(fs.renameSync.called).to.be.false
            expect(fs.unlinkSync.calledOnceWith(tmpPath)).to.be.true
        })

        it('removes the temp file and reports the error when the rename over the original fails', function () {
            const fs = makeFs({ existsSync: sinon.stub().returns(true), renameSync: sinon.stub().throws(fsError('EPERM')) })
            expect(() => loadCredentialsService(fs).saveCredentials({ user: 'u', password: 'p' })).to.throw('EPERM')
            expect(fs.unlinkSync.calledOnceWith(fs.writeFileSync.firstCall.args[0])).to.be.true
        })
    })
})
