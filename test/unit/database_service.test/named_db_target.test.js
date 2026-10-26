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

// resolveNamedDatabaseTarget answers for the MariaDB container a `reset --db-container` names: its id, a root
// password that logs in to it, and proof the target databases are already there. The root is another server's,
// so it must never reach the CLI's own cached or stored root.

const { sinon, expect, fakeSpawn, makeStubs, loadDatabaseService } = require('./helpers/harness')

const NAMED = 'xchain-rail-database'
const NAMED_ID = 'c'.repeat(64)

// Docker as the named container answers it: inspect by name, one root env name set, a ping that logs in.
function namedServer(stubs, { rootVar = 'MYSQL_ROOT_PASSWORD', root = 'named-root', pingAlive = true } = {}) {
    stubs.execFileAsync.callsFake(async (cmd, args, opts) => {
        if (args[0] === 'inspect' && args[args.length - 1] === NAMED) return { stdout: NAMED_ID + '\n' }
        if (args[0] === 'exec' && args[2] === 'printenv') {
            if (args[3] === rootVar) return { stdout: root + '\n' }
            throw new Error('exit status 1')
        }
        if (args.includes('mariadb-admin')) {
            if (pingAlive && opts && opts.env && opts.env.MYSQL_PWD === root) return { stdout: 'mysqld is alive\n' }
            throw new Error('Access denied for user root')
        }
        throw new Error('unexpected docker call: ' + args.join(' '))
    })
}

// The catalogue answer for every target database: 1 when present, 0 when not.
function schemaAnswer(stubs, present) {
    stubs.spawn.callsFake(fakeSpawn((sql) => ({ stdout: /SCHEMATA/.test(sql) ? (present ? '1' : '0') : '' })))
}

async function rejection(promise) {
    try { await promise } catch (err) { return err }
    return null
}

describe('DatabaseService', function () {
    describe('resolveNamedDatabaseTarget()', function () {

        it('resolves the named container, its own root, and the databases it already holds', async function () {
            const stubs = makeStubs()
            namedServer(stubs)
            schemaAnswer(stubs, true)
            const ds = loadDatabaseService(stubs)

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', ['xchain-decoder', 'xchain-indexer'])

            expect(target).to.deep.equal({ containerName: NAMED, containerId: NAMED_ID, rootPassword: 'named-root',
                databases: ['XChain_BTC_Mainnet_Decoder', 'XChain_BTC_Mainnet_Indexer'] })
            for (const call of stubs.spawn.getCalls()) expect(call.args[1]).to.include(NAMED_ID)
            // Another server's root never lands in the CLI's own root cache or credentials store.
            expect(stubs.setDbRootPassword.called).to.be.false
            expect(stubs.saveDbRootPassword.called).to.be.false
        })

        it('reads the root from MARIADB_ROOT_PASSWORD when that is the name the container uses', async function () {
            const stubs = makeStubs()
            namedServer(stubs, { rootVar: 'MARIADB_ROOT_PASSWORD', root: 'other-root' })
            schemaAnswer(stubs, true)
            const ds = loadDatabaseService(stubs)

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', ['xchain-decoder'])
            expect(target.rootPassword).to.equal('other-root')
        })

        it('refuses a container name docker would not accept, before any docker call', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)

            const err = await rejection(ds.resolveNamedDatabaseTarget('db;reboot', 'bitcoin', 'mainnet', ['xchain-decoder']))
            expect(err && err.message).to.contain('not a valid docker container name')
            expect(stubs.execFileAsync.called).to.be.false
        })

        it('refuses when no root password in the container logs in', async function () {
            const stubs = makeStubs()
            namedServer(stubs, { pingAlive: false })
            const ds = loadDatabaseService(stubs)

            const err = await rejection(ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', ['xchain-decoder']))
            expect(err && err.message).to.contain('no root password')
            expect(stubs.spawn.called).to.be.false
        })

        it('refuses a server that does not hold the target database', async function () {
            const stubs = makeStubs()
            namedServer(stubs)
            schemaAnswer(stubs, false)
            const ds = loadDatabaseService(stubs)

            const err = await rejection(ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', ['xchain-decoder']))
            expect(err && err.message).to.contain('holds no database XChain_BTC_Mainnet_Decoder')
        })
    })
})
