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

describe('DatabaseService', function () {
    describe('resolveNamedDatabaseTarget() root override', function () {
        const VAR = 'XCHAIN_NODE_DB_CONTAINER_ROOT_PASSWORD'
        afterEach(function () { delete process.env[VAR] })

        it('logs in with it when the container was started without a root env', async function () {
            const stubs = makeStubs()
            namedServer(stubs, { rootVar: 'NO_SUCH_VAR', root: 'moved-in-root' })
            schemaAnswer(stubs, true)
            process.env[VAR] = 'moved-in-root'
            const ds = loadDatabaseService(stubs)

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'regtest', ['xchain-decoder', 'xchain-indexer'])
            expect(target.rootPassword).to.equal('moved-in-root')
            expect(stubs.setDbRootPassword.called).to.be.false
            expect(stubs.saveDbRootPassword.called).to.be.false
        })

        it('refuses by name when it does not log in, before any database read', async function () {
            const stubs = makeStubs()
            namedServer(stubs, { rootVar: 'NO_SUCH_VAR', root: 'real-root' })
            process.env[VAR] = 'wrong-root'
            const ds = loadDatabaseService(stubs)

            const err = await rejection(ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'regtest', ['xchain-decoder']))
            expect(err && err.message).to.contain(`${VAR} does not log in to ${NAMED}`)
            expect(err.message).to.not.contain('wrong-root')
            expect(stubs.spawn.called).to.be.false
        })

        it('is not read when the container env root logs in', async function () {
            const stubs = makeStubs()
            namedServer(stubs)
            schemaAnswer(stubs, true)
            process.env[VAR] = 'unused-root'
            const ds = loadDatabaseService(stubs)

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', ['xchain-decoder'])
            expect(target.rootPassword).to.equal('named-root')
        })
    })
})

// A named server with no usable root, whose stack's service containers carry their own database logins. Each user
// logs in only with its own password and answers SHOW GRANTS with the lines given, as `mariadb -B -N` prints them
// (backslashes doubled). `env` is the indexer container's environment; the decoder container's is `decoderEnv`.
const INDEXER_ID = 'b'.repeat(64)
const DECODER_ID = 'a'.repeat(64)
const DB = { decoder: 'XChain_BTC_Mainnet_Decoder', indexer: 'XChain_BTC_Mainnet_Indexer', hub: 'XChain_Hub' }
const SECRETS = { dec_user: 'dec-secret-1', idx_user: 'idx-secret-2', hub_user: 'hub-secret-3' }
const SERVICE_ENV = {
    DECODER_DB_NAME: DB.decoder, DECODER_DB_USER: 'dec_user', DECODER_DB_PASS: SECRETS.dec_user,
    INDEXER_DB_NAME: DB.indexer, INDEXER_DB_USER: 'idx_user', INDEXER_DB_PASS: SECRETS.idx_user,
    HUB_DB_NAME: DB.hub, HUB_DB_USER: 'hub_user', HUB_DB_PASS: SECRETS.hub_user
}
const FULL_GRANTS = {
    dec_user: ['GRANT USAGE ON *.* TO `dec_user`@`%` IDENTIFIED BY PASSWORD \'*AB12\'',
        'GRANT ALL PRIVILEGES ON `XChain\\\\_BTC\\\\_Mainnet\\\\_Decoder`.* TO `dec_user`@`%`'],
    idx_user: ['GRANT USAGE ON *.* TO `idx_user`@`%`', 'GRANT SELECT, INSERT, DROP, CREATE ON `XChain_BTC_Mainnet_Indexer`.* TO `idx_user`@`%`'],
    hub_user: ['GRANT USAGE ON *.* TO `hub_user`@`%`', 'GRANT SELECT, DELETE ON `XChain_Hub`.`price_ingest_watermarks` TO `hub_user`@`%`']
}

function serviceServer(stubs, { env = SERVICE_ENV, decoderEnv = {}, grants = FULL_GRANTS, passwords = SECRETS } = {}) {
    const envs = { [INDEXER_ID]: env, [DECODER_ID]: decoderEnv }
    stubs.execFileAsync.callsFake(async (cmd, args, opts) => {
        if (args[0] === 'inspect' && args[args.length - 1] === NAMED) return { stdout: NAMED_ID + '\n' }
        // Service env is read from the container config, which a stopped container still answers.
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
            const env = envs[args[args.length - 1]]
            if (!env) throw new Error('Error: No such object')
            return { stdout: JSON.stringify(Object.entries(env).map(([k, v]) => k + '=' + v)) + '\n' }
        }
        if (args[0] === 'exec' && args[2] === 'printenv') throw new Error('exit status 1')
        if (args.includes('mariadb-admin')) throw new Error('Access denied for user root')
        throw new Error('unexpected docker call: ' + args.join(' '))
    })
    stubs.spawn.callsFake(fakeSpawn((sql, args, opts) => {
        const user = args[args.indexOf('-u') + 1]
        if (!passwords[user] || opts.env.MYSQL_PWD !== passwords[user]) {
            return { code: 1, stderr: `ERROR 1045 (28000): Access denied for user '${user}'@'localhost' (using password: YES)` }
        }
        if (/SHOW GRANTS/.test(sql)) return { stdout: (grants[user] || []).join('\n') }
        if (/SCHEMATA/.test(sql)) return { stdout: '1' }
        return { stdout: '' }
    }))
}

// The stack's service containers as the reset's name lookup finds them.
function finder() {
    return sinon.stub().callsFake(async (module) => ({ 'xchain-indexer': INDEXER_ID, 'xchain-decoder': DECODER_ID })[module] || null)
}

function expectNoSecret(text) {
    for (const secret of Object.values(SECRETS)) expect(String(text)).to.not.contain(secret)
}

const BOTH = ['xchain-decoder', 'xchain-indexer']

describe('DatabaseService', function () {
    describe('resolveNamedDatabaseTarget() service logins', function () {

        it('falls back to the stack\'s own users only when no root logs in, and reports their grants', async function () {
            const stubs = makeStubs()
            serviceServer(stubs)
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: DB.hub })

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', BOTH, finder())

            expect(target.authMode).to.equal('service')
            expect(target).to.not.have.property('rootPassword')
            expect(target.logins[DB.decoder].user).to.equal('dec_user')
            expect(target.logins[DB.indexer].user).to.equal('idx_user')
            expect(target.hubLogin.user).to.equal('hub_user')
            const report = target.authReport.join('\n')
            expect(report).to.contain('no root password').and.to.contain('dec_user').and.to.contain('ALL PRIVILEGES ON')
                .and.to.contain('SELECT, DELETE ON `XChain_Hub`.`price_ingest_watermarks`')
            expectNoSecret(report)
            expectNoSecret(JSON.stringify(target))
            for (const call of stubs.spawn.getCalls()) expect(call.args[1]).to.not.include('root')
        })

        it('reads the service logins from container config, so a stack stopped for the reset still answers', async function () {
            const stubs = makeStubs()
            serviceServer(stubs)
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: DB.hub })

            await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', BOTH, finder())

            const serviceExecs = stubs.execFileAsync.getCalls()
                .filter((c) => c.args[1][0] === 'exec' && [INDEXER_ID, DECODER_ID].includes(c.args[1][1]))
            expect(serviceExecs).to.have.length(0)
        })

        it('never reads a service login when the container\'s root logs in', async function () {
            const stubs = makeStubs()
            namedServer(stubs)
            schemaAnswer(stubs, true)
            const find = finder()
            const ds = loadDatabaseService(stubs)

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', BOTH, find)
            expect(target.rootPassword).to.equal('named-root')
            expect(find.called).to.be.false
        })

        it('reads a login from the decoder container when the indexer\'s env lacks it', async function () {
            const stubs = makeStubs()
            const { DECODER_DB_USER, DECODER_DB_PASS, DECODER_DB_NAME, ...indexerOnly } = SERVICE_ENV
            serviceServer(stubs, { env: indexerOnly, decoderEnv: { DECODER_DB_USER, DECODER_DB_PASS, DECODER_DB_NAME } })
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: DB.hub })

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', BOTH, finder())
            expect(target.logins[DB.decoder].source).to.equal('xchain-decoder')
        })
    })
})

describe('DatabaseService', function () {
    describe('resolveNamedDatabaseTarget() service hub login', function () {

        it('does not need a hub login for a decoder-only reset', async function () {
            const stubs = makeStubs()
            const { HUB_DB_USER, HUB_DB_PASS, ...noHub } = SERVICE_ENV
            serviceServer(stubs, { env: noHub })
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: DB.hub })

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', ['xchain-decoder'], finder())
            expect(target.hubLogin).to.equal(null)
        })

        it('skips the fence clear with a note when the stack\'s hub uses another database', async function () {
            const stubs = makeStubs()
            serviceServer(stubs, { env: { ...SERVICE_ENV, HUB_DB_NAME: 'Rail_Hub' } })
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: DB.hub })

            const target = await ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', BOTH, finder())
            expect(target.hubLogin).to.equal(null)
            expect(target.authReport.join('\n')).to.contain('names Rail_Hub, not XChain_Hub')
        })
    })
})

describe('DatabaseService', function () {
    describe('resolveNamedDatabaseTarget() service login refusals', function () {

        async function refusal(options, modules = BOTH) {
            const stubs = makeStubs()
            serviceServer(stubs, options)
            const ds = loadDatabaseService(stubs, {}, { HUB_DB_NAME: DB.hub })
            const err = await rejection(ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', modules, finder()))
            expect(err, 'expected a refusal').to.not.equal(null)
            expectNoSecret(err.message)
            // The root failure stays in the message beside the service one.
            expect(err.message).to.contain('no root password')
            return err.message
        }

        it('refuses when a target database has no login in either container\'s env', async function () {
            const { INDEXER_DB_PASS, ...env } = SERVICE_ENV
            expect(await refusal({ env })).to.contain('carries INDEXER_DB_USER and INDEXER_DB_PASS')
        })

        it('refuses a login that does not log in, naming the user', async function () {
            expect(await refusal({ passwords: { ...SECRETS, dec_user: 'not-the-env-one' } }))
                .to.contain('DECODER_DB_USER dec_user does not log in to ' + NAMED)
        })

        it('refuses when the stack\'s services cannot be found', async function () {
            const stubs = makeStubs()
            serviceServer(stubs)
            const ds = loadDatabaseService(stubs)
            const err = await rejection(ds.resolveNamedDatabaseTarget(NAMED, 'bitcoin', 'mainnet', BOTH))
            expect(err && err.message).to.contain('no indexer or decoder container was found')
        })

        for (const [missing, privileges] of [['DROP', 'SELECT, INSERT, CREATE, CREATE VIEW'], ['CREATE', 'SELECT, DROP, CREATE VIEW, CREATE ROUTINE']]) {
            it(`refuses a database user whose grants lack ${missing}`, async function () {
                const grants = { ...FULL_GRANTS, idx_user: [`GRANT ${privileges} ON \`XChain_BTC_Mainnet_Indexer\`.* TO \`idx_user\`@\`%\``] }
                expect(await refusal({ grants })).to.contain(`INDEXER_DB_USER idx_user has no ${missing} grant on ${DB.indexer}`)
            })
        }

        it('refuses a grant on another database, even with ALL PRIVILEGES', async function () {
            const grants = { ...FULL_GRANTS, dec_user: ['GRANT ALL PRIVILEGES ON `XChain_BTC_Regtest_Decoder`.* TO `dec_user`@`%`'] }
            expect(await refusal({ grants })).to.contain(`has no DROP or CREATE grant on ${DB.decoder}`)
        })

        it('refuses a hub user without DELETE on the fence table', async function () {
            const grants = { ...FULL_GRANTS, hub_user: ['GRANT SELECT ON `XChain_Hub`.* TO `hub_user`@`%`'] }
            expect(await refusal({ grants })).to.contain('HUB_DB_USER hub_user has no DELETE grant on XChain_Hub.price_ingest_watermarks')
        })

        it('refuses when the stack names another database than the reset targets', async function () {
            expect(await refusal({ env: { ...SERVICE_ENV, DECODER_DB_NAME: 'Other_Decoder' } }))
                .to.contain(`DECODER_DB_NAME in the xchain-indexer container names Other_Decoder, not ${DB.decoder}`)
        })
    })
})
