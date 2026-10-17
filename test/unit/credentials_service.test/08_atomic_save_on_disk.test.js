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

// Runs the credentials.json save on a real filesystem, where rename, mode bits and the
// quarantine copy are the operating system's, not a stub's.

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { sinon, expect, loadCredentialsService } = require('./support/helpers')

let home, credsDir, credsFile, warnStub

// Load the service with the real fs and a home directory inside a fresh temp dir.
function loadOnDisk() {
    return loadCredentialsService(fs, { homedir: () => home, userInfo: () => ({ username: 'testuser' }) })
}

describe('CredentialsService', function () {
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-creds-'))
        credsDir = path.join(home, '.xchain-node')
        credsFile = path.join(credsDir, 'credentials.json')
        fs.mkdirSync(credsDir, { mode: 0o700 })
        warnStub = sinon.stub(console, 'warn')
    })

    afterEach(() => {
        warnStub.restore()
        fs.rmSync(home, { recursive: true, force: true })
    })

    describe('atomic save on a real filesystem', function () {
        it('keeps a torn file byte for byte beside a fresh 0600 credentials.json, with no temp file left', function () {
            const torn = '{"user":"u","password":"p","externalDb":{"host":"h"'
            fs.writeFileSync(credsFile, torn, { mode: 0o600 })
            loadOnDisk().saveDbRootPassword('pw')

            const names = fs.readdirSync(credsDir)
            const aside = names.filter(n => n.startsWith('credentials.json.corrupt-'))
            expect(aside).to.have.length(1)
            expect(fs.readFileSync(path.join(credsDir, aside[0]), 'utf8')).to.equal(torn)
            expect(JSON.parse(fs.readFileSync(credsFile, 'utf8'))).to.deep.equal({ dbRootPassword: 'pw' })
            expect(names.filter(n => n.endsWith('.tmp'))).to.have.length(0)
            if (process.platform !== 'win32') expect(fs.statSync(credsFile).mode & 0o777).to.equal(0o600)
        })

        it('keeps every sibling block of a valid file across saves from all three helpers', function () {
            const cs = loadOnDisk()
            cs.saveCredentials({ user: 'u', password: 'p', database: 'xchain_node' })
            cs.saveExternalDbConfig({ host: 'h', port: 3306, root_user: 'r', root_password: 'rp' })
            cs.saveDbRootPassword('pw')

            expect(JSON.parse(fs.readFileSync(credsFile, 'utf8'))).to.deep.equal({
                user: 'u', password: 'p', database: 'xchain_node',
                externalDb: { host: 'h', port: 3306, root_user: 'r', root_password: 'rp' },
                dbRootPassword: 'pw'
            })
            expect(fs.readdirSync(credsDir)).to.deep.equal(['credentials.json'])
            expect(warnStub.called).to.be.false
        })
    })
})
