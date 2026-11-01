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

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { sinon, expect, VALID_CONTAINER_ID, makeStubs, loadDatabaseService } = require('../helpers/harness')

// A datadir pinned with XCHAIN_NODE_DB_DATA_DIR survives `docker rm`, and the mariadb image
// ignores MYSQL_ROOT_PASSWORD once <datadir>/mysql exists, so a recreated container keeps the
// old root password. No password may be stored for it until it authenticates.

const DENIED = "mariadb-admin: connect to server at 'localhost' failed\nerror: 'Access denied for user 'root'@'localhost''"

const madeDirs = []
after(() => { for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true }) })

// Make a temporary datadir, already initialised (holding mysql/) unless told otherwise.
function makeDatadir({ initialised = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xn-datadir-'))
    madeDirs.push(dir)
    if (initialised) fs.mkdirSync(path.join(dir, 'mysql'))
    return dir
}

// Answer docker the way a host with no DB container, a working run, and a server whose root
// password is `realRoot` would; `down` makes every ping fail as a server that never came up.
// The container is absent until `docker run`, then inspect finds it; a root login
// through the mariadb client (the first-boot wait) succeeds only with `realRoot`.
function fakeDocker(stubs, { realRoot, down = false }) {
    let started = false
    stubs.execFileAsync.callsFake(async (cmd, args, opts) => {
        if (args[0] === 'inspect') {
            if (!started) throw new Error('Error: No such container: xchain-node-database')
            return { stdout: VALID_CONTAINER_ID + '\n', stderr: '' }
        }
        if (args[0] === 'run') { started = true; return { stdout: VALID_CONTAINER_ID + '\n', stderr: '' } }
        if (args[0] === 'exec' && (args.includes('mariadb-admin') || args.includes('mariadb'))) {
            if (down) throw Object.assign(new Error('ping failed'), { stderr: "Can't connect to local server through socket" })
            if (opts && opts.env && opts.env.MYSQL_PWD === realRoot) return { stdout: 'mysqld is alive\n', stderr: '' }
            if (args.includes('mariadb')) throw Object.assign(new Error('denied'), { stderr: DENIED })
            return { stdout: '', stderr: DENIED }
        }
        return { stdout: '', stderr: '' }
    })
}

// Run `fn` with the datadir, env override and stdin TTY set as asked, restoring all three after.
async function withEnv({ datadir, envPassword = null, tty = false }, fn) {
    const saved = { dir: process.env.XCHAIN_NODE_DB_DATA_DIR, pw: process.env.XCHAIN_NODE_DB_ROOT_PASSWORD }
    const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    if (datadir === undefined) delete process.env.XCHAIN_NODE_DB_DATA_DIR
    else process.env.XCHAIN_NODE_DB_DATA_DIR = datadir
    if (envPassword === null) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
    else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = envPassword
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
    try {
        return await fn()
    } finally {
        if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
        else delete process.stdin.isTTY
        if (saved.dir === undefined) delete process.env.XCHAIN_NODE_DB_DATA_DIR
        else process.env.XCHAIN_NODE_DB_DATA_DIR = saved.dir
        if (saved.pw === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
        else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved.pw
    }
}

// Resolve the root password with no DB container, docker confirming it gone.
async function resolveRoot({ datadir, stored = null, envPassword = null, tty = false, realRoot = 'old-root' }) {
    const stubs = makeStubs()
    stubs.getDbRootPassword.returns(null)
    stubs.loadDbRootPassword.returns(stored)
    fakeDocker(stubs, { realRoot })
    return withEnv({ datadir, envPassword, tty }, async () => {
        const ds = loadDatabaseService(stubs)
        let err = null
        let result = null
        try { result = await ds.askMariadbRootPassword('', '') } catch (e) { err = e }
        return { stubs, err, result }
    })
}

describe('DatabaseService', function () {
    afterEach(() => sinon.restore())

    describe('askMariadbRootPassword() over a datadir that already holds a database', function () {

        it('uses the stored copy over a different env override and saves nothing, naming no value', async function () {
            const warn = sinon.stub(console, 'warn')
            const { stubs, err, result } = await resolveRoot({ datadir: makeDatadir(), stored: 'old-root', envPassword: 'new-root' })
            expect(err).to.equal(null)
            expect(result).to.equal('old-root')
            expect(stubs.saveDbRootPassword.called).to.equal(false)
            const text = warn.args.map(a => a.join(' ')).join('\n')
            expect(text).to.include('XCHAIN_NODE_DB_ROOT_PASSWORD differs')
            expect(text).to.not.include('new-root')
            expect(text).to.not.include('old-root')
        })

        it('uses the stored copy with no env override, without prompting or saving', async function () {
            const { stubs, result } = await resolveRoot({ datadir: makeDatadir(), stored: 'old-root' })
            expect(result).to.equal('old-root')
            expect(stubs.saveDbRootPassword.called).to.equal(false)
        })

        it('uses the env override when nothing is stored, without saving it', async function () {
            const { stubs, result } = await resolveRoot({ datadir: makeDatadir(), envPassword: 'env-root' })
            expect(result).to.equal('env-root')
            expect(stubs.saveDbRootPassword.called).to.equal(false)
        })

        it('refuses with no candidate and no TTY, naming the datadir and the variable', async function () {
            const datadir = makeDatadir()
            const { stubs, err } = await resolveRoot({ datadir })
            expect(err).to.be.an('error')
            expect(err.message).to.include(datadir)
            expect(err.message).to.include('XCHAIN_NODE_DB_ROOT_PASSWORD')
            expect(stubs.setDbRootPassword.called).to.equal(false)
            expect(stubs.saveDbRootPassword.called).to.equal(false)
        })

    })
})

describe('DatabaseService', function () {
    afterEach(() => sinon.restore())

    describe('askMariadbRootPassword() over a datadir that already holds a database', function () {

        it('treats a named volume as initialised, since it persists', async function () {
            const { stubs, result } = await resolveRoot({ datadir: 'xn-db-volume', envPassword: 'env-root' })
            expect(result).to.equal('env-root')
            expect(stubs.saveDbRootPassword.called).to.equal(false)
        })

        it('treats a datadir it cannot read as initialised', async function () {
            if (typeof process.getuid === 'function' && process.getuid() === 0) this.skip()
            const datadir = makeDatadir()
            fs.chmodSync(datadir, 0o000)
            try {
                const { stubs, result } = await resolveRoot({ datadir, envPassword: 'env-root' })
                expect(result).to.equal('env-root')
                expect(stubs.saveDbRootPassword.called).to.equal(false)
            } finally {
                fs.chmodSync(datadir, 0o700)
            }
        })

        it('keeps the fresh-install path for a datadir with no mysql/ in it', async function () {
            const { stubs, result } = await resolveRoot({ datadir: makeDatadir({ initialised: false }), envPassword: 'env-root' })
            expect(result).to.equal('env-root')
            expect(stubs.saveDbRootPassword.calledOnceWith('env-root')).to.equal(true)
        })
    })
})

// Install the DB container with no container present and docker confirming it gone.
async function install({ datadir, stored = null, envPassword = null, realRoot, down = false }) {
    const stubs = makeStubs()
    stubs.getDbRootPassword.returns(null)
    stubs.loadDbRootPassword.returns(stored)
    fakeDocker(stubs, { realRoot, down })
    return withEnv({ datadir, envPassword }, async () => {
        const ds = loadDatabaseService(stubs)
        let err = null
        let result = null
        try { result = await ds.buildDatabaseModule('', '') } catch (e) { err = e }
        return { stubs, err, result }
    })
}

describe('DatabaseService', function () {
    afterEach(() => sinon.restore())

    describe('buildDatabaseModule() over a datadir that already holds a database', function () {

        it('stores the chosen root password once it authenticates against the new container', async function () {
            const { stubs, err, result } = await install({ datadir: makeDatadir(), stored: 'old-root', envPassword: 'new-root', realRoot: 'old-root' })
            expect(err).to.equal(null)
            expect(result).to.equal(VALID_CONTAINER_ID)
            expect(stubs.saveDbRootPassword.calledOnceWithExactly('old-root')).to.equal(true)
        })

        it('falls back to the env override when the stored copy is refused, and stores that one', async function () {
            const { stubs, err } = await install({ datadir: makeDatadir(), stored: 'stale-root', envPassword: 'real-root', realRoot: 'real-root' })
            expect(err).to.equal(null)
            expect(stubs.setDbRootPassword.calledWith('real-root')).to.equal(true)
            expect(stubs.saveDbRootPassword.calledOnceWithExactly('real-root')).to.equal(true)
        })

        it('refuses and stores nothing when no candidate authenticates', async function () {
            const datadir = makeDatadir()
            const { stubs, err } = await install({ datadir, stored: 'stale-root', envPassword: 'other-root', realRoot: 'real-root' })
            expect(err).to.be.an('error')
            expect(err.message).to.include(datadir)
            expect(err.message).to.include('credentials.json was left untouched')
            expect(stubs.saveDbRootPassword.called).to.equal(false)
        })

        it('refuses and stores nothing when the new container never answers a ping', async function () {
            const { stubs, err } = await install({ datadir: makeDatadir(), stored: 'old-root', realRoot: 'old-root', down: true })
            expect(err).to.be.an('error')
            expect(err.message).to.match(/did not answer a root ping/)
            expect(stubs.saveDbRootPassword.called).to.equal(false)
        })

        it('waits on a fresh datadir until the password it was given logs in, with no persisted-password check', async function () {
            const { stubs, err } = await install({ datadir: makeDatadir({ initialised: false }), envPassword: 'env-root', realRoot: 'env-root' })
            expect(err).to.equal(null)
            expect(stubs.saveDbRootPassword.calledOnceWithExactly('env-root')).to.equal(true)
            const confirms = stubs.execFileAsync.getCalls().filter(c => c.args[1].includes('mariadb-admin'))
            expect(confirms).to.have.lengthOf(0)
            const logins = stubs.execFileAsync.getCalls().filter(c => c.args[1].includes('mariadb') && c.args[1].includes('root'))
            expect(logins.length).to.be.greaterThan(0)
            expect(logins[0].args[2].env.MYSQL_PWD).to.equal('env-root')
        })

        it('stops the install with an actionable error when a fresh container never accepts a login', async function () {
            const { err } = await install({ datadir: makeDatadir({ initialised: false }), envPassword: 'env-root', realRoot: 'env-root', down: true })
            expect(err).to.be.an('error')
            expect(err.message).to.match(/did not accept connections within 5 min of starting/)
            expect(err.message).to.include('docker logs xchain-node-database')
        })
    })
})
