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

// External-DB mode comes from process env alone. A run that lost the flag on a host recorded as
// external-DB must be refused before any bundled container, root-password source or prompt is reached.

const { sinon, expect, VALID_CONTAINER_ID, makeStubs, loadDatabaseService } = require('../helpers/harness')

// No existing database container: the first `docker inspect` rejects, so the install branch is entered.
function stubsWithoutContainer(overrides = {}) {
    const stubs = makeStubs(overrides)
    stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
    stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
    return stubs
}

function dockerRunCalls(stubs) {
    return stubs.execFileAsync.getCalls().filter(c => c.args[0] === 'docker' && c.args[1][0] === 'run')
}

async function refused(ds) {
    return ds.buildDatabaseModule('', '').then(() => null, (e) => e)
}

function registerRefusalCases() {
    it('refuses a host with a saved externalDb block and creates nothing', async function () {
        const stubs = stubsWithoutContainer({ isKnownExternalDbHost: sinon.stub().returns(true) })
        const ds = loadDatabaseService(stubs)
        const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
        process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'exported-root-pass'
        try {
            const err = await refused(ds)
            expect(err).to.be.an.instanceOf(Error)
            expect(err.code).to.equal('EXTERNAL_DB_MODE_LOST')
            expect(err.message).to.include('XCHAIN_NODE_EXTERNAL_DB=1')
            expect(err.message).to.include(process.cwd())
            expect(err.message).to.include('externalDbMode')
        } finally {
            if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
        }
        expect(dockerRunCalls(stubs)).to.have.length(0)
        expect(stubs.getDbRootPassword.called).to.equal(false)
        expect(stubs.forceRemoveContainerByName.called).to.equal(false)
        expect(stubs.saveCredentials.called).to.equal(false)
    })

    it('leaves a host with no external-DB record on the fresh-install path', async function () {
        const stubs = stubsWithoutContainer()
        const ds = loadDatabaseService(stubs)
        await ds.buildDatabaseModule('bitcoin', 'mainnet')
        expect(dockerRunCalls(stubs)).to.have.length(1)
    })

    it('does not consult the record when a database container already exists', async function () {
        const isKnownExternalDbHost = sinon.stub().returns(true)
        const stubs = makeStubs({ isKnownExternalDbHost })
        const ds = loadDatabaseService(stubs)
        expect(await ds.buildDatabaseModule('bitcoin', 'mainnet')).to.equal(true)
        expect(isKnownExternalDbHost.called).to.equal(false)
    })
}

function registerMarkerCases() {
    it('records external-DB mode once the external server answers', async function () {
        const stubs = makeStubs()
        const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true }, {}, {})
        const saved = setExternalEnv()
        try {
            expect(await ds.buildDatabaseModule('bitcoin', 'mainnet')).to.equal(true)
        } finally { restoreEnv(saved) }
        expect(stubs.markExternalDbMode.calledOnce).to.equal(true)
    })

    it('does not fail the command when the marker cannot be written', async function () {
        const stubs = makeStubs({ markExternalDbMode: sinon.stub().throws(new Error('EACCES')) })
        const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
        const saved = setExternalEnv()
        try {
            expect(await ds.buildDatabaseModule('bitcoin', 'mainnet')).to.equal(true)
        } finally { restoreEnv(saved) }
    })

    it('records nothing when the external server is unreachable', async function () {
        const stubs = makeStubs()
        stubs.mariadb.createConnection.rejects(new Error('ECONNREFUSED'))
        const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
        const saved = setExternalEnv()
        try {
            const err = await refused(ds)
            expect(err.message).to.include('Cannot reach external MariaDB')
        } finally { restoreEnv(saved) }
        expect(stubs.markExternalDbMode.called).to.equal(false)
    })
}

const EXTERNAL_ENV = {
    XCHAIN_NODE_EXTERNAL_DB_HOST: '127.0.0.1', XCHAIN_NODE_EXTERNAL_DB_PORT: '3306',
    XCHAIN_NODE_EXTERNAL_DB_ROOT_USER: 'root', XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'test-pass'
}

function setExternalEnv() {
    const saved = {}
    for (const [k, v] of Object.entries(EXTERNAL_ENV)) {
        saved[k] = process.env[k]
        process.env[k] = v
    }
    return saved
}

function restoreEnv(saved) {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
}

describe('DatabaseService', function () {
    describe('buildDatabaseModule(): a run that lost the external-DB flag', registerRefusalCases)
    describe('buildDatabaseModule(): external-DB mode marker', registerMarkerCases)
})
