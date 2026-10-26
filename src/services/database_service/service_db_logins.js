/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Database Service
 * A named server's reset run as the stack's own database users, when no root login is available for it
 ********************************************************************/

let { execFile } = require('child_process')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let { XChainService, HUB_MODULE_NAME } = require('../../config')
let { getDefaultConfig } = require('../config_service')
let { assertSafeDbIdentifier } = require('../../utils/sql_safety')
let { executeDockerMariaDbCommand, executeDockerMariaDbCommandAs } = require('./mariadb_exec')
const { CURRENT_USER_GRANTS_SQL } = require('../../db/information_schema')
const { PRICE_FENCE_TABLE } = require('../../db/price_fence')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, execFileAsync, XChainService, HUB_MODULE_NAME, getDefaultConfig, assertSafeDbIdentifier, executeDockerMariaDbCommand, executeDockerMariaDbCommandAs } = dependencies)
}

// The env prefix each reset database's login sits under in the stack's service containers.
function loginPrefixFor(module) {
    if (module === XChainService.XCHAIN_DECODER) return 'DECODER'
    if (module === XChainService.XCHAIN_INDEXER) return 'INDEXER'
    throw new Error(`${module} has no database login this reset knows`)
}

// MariaDB's own user-name characters. The name reaches the client's argv, so a leading dash is never accepted.
const DB_USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,79}$/

// A login read from a service container. The password is not enumerable, so logging or serialising the login
// object shows the user and never the password.
function makeLogin(prefix, source, user, password, envDatabase) {
    const login = { prefix, source, user, envDatabase, database: null, grants: [] }
    Object.defineProperty(login, 'password', { value: password, enumerable: false })
    return login
}

// One variable from a service container's environment, or null when it is unset or the container cannot answer.
async function readServiceEnv(containerId, name) {
    try {
        const { stdout } = await execFileAsync('docker', ['exec', containerId, 'printenv', name])
        return String(stdout).replace(/\r?\n$/, '') || null
    } catch {
        return null
    }
}

// The containers whose env carries the stack's logins, indexer first, then decoder. A failed lookup throws (the
// finder's own rule), so the reset refuses rather than guess.
async function serviceEnvSources(findServiceContainer) {
    const sources = []
    for (const module of [XChainService.XCHAIN_INDEXER, XChainService.XCHAIN_DECODER]) {
        const id = await findServiceContainer(module)
        if (id) sources.push({ module, id })
    }
    if (!sources.length) throw new Error('no indexer or decoder container was found to read the database logins from')
    return sources
}

// Read <prefix>_DB_USER and _DB_PASS from the first container that carries both, plus its _DB_NAME when set.
// The values are held in memory for this run only: never printed, cached or saved.
async function readLogin(sources, prefix) {
    for (const source of sources) {
        const user = await readServiceEnv(source.id, `${prefix}_DB_USER`)
        const password = user ? await readServiceEnv(source.id, `${prefix}_DB_PASS`) : null
        if (!user || !password) continue
        // Refuse a name the client could misread, without echoing it.
        if (!DB_USER_NAME.test(user)) throw new Error(`${prefix}_DB_USER in the ${source.module} container is not a MariaDB user name`)
        return makeLogin(prefix, source.module, user, password, await readServiceEnv(source.id, `${prefix}_DB_NAME`))
    }
    throw new Error(`no indexer or decoder container's environment carries ${prefix}_DB_USER and ${prefix}_DB_PASS`)
}

// One SHOW GRANTS line: its privilege list and the scope after ON. Role and PROXY grants carry no database scope.
const GRANT_LINE = /^GRANT\s+(.+?)\s+ON\s+(?:TABLE\s+)?(\S+)\s+TO\s/i

function parseGrant(line) {
    const match = GRANT_LINE.exec(String(line).trim())
    if (!match) return null
    return { privileges: match[1].split(',').map((p) => p.trim().toUpperCase()), scope: match[2], text: `${match[1]} ON ${match[2]}` }
}

// A quoted name as SHOW GRANTS prints it: doubled backticks are one, and the backslash MariaDB puts before a
// wildcard character in a database name (doubled again in batch output) is dropped, leaving the literal name.
function unquoteGrantName(name) {
    return name.replace(/``/g, '`').replace(/\\+([_%])/g, '$1')
}

// Whether a grant scope covers the whole database (table null), or that one table in it. *.* covers everything;
// a scope naming another database, or a pattern that is not this exact name, does not count.
function scopeCovers(scope, database, table) {
    if (scope === '*.*') return true
    const match = /^`((?:[^`]|``)+)`\.(\*|`((?:[^`]|``)+)`)$/.exec(scope)
    if (!match || unquoteGrantName(match[1]) !== database) return false
    return match[2] === '*' || (table !== null && unquoteGrantName(match[3]) === table)
}

// Which of the needed privileges the grant lines leave missing on that scope, and the lines that gave the rest.
// ALL PRIVILEGES gives every one; CREATE VIEW and the like are other privileges and do not stand in for CREATE.
function grantedPrivileges(lines, needed, database, table = null) {
    const found = new Set()
    const matched = []
    for (const grant of lines.map(parseGrant).filter(Boolean)) {
        if (!scopeCovers(grant.scope, database, table)) continue
        const all = grant.privileges.includes('ALL PRIVILEGES') || grant.privileges.includes('ALL')
        const hits = needed.filter((p) => all || grant.privileges.includes(p))
        if (!hits.length) continue
        matched.push(grant.text)
        for (const p of hits) found.add(p)
    }
    return { missing: needed.filter((p) => !found.has(p)), matched }
}

// The stack's own config must name the database this reset targets, or its login guards some other database.
function checkLoginNamesDatabase(login, database) {
    if (login.envDatabase && login.envDatabase !== database) {
        throw new Error(`${login.prefix}_DB_NAME in the ${login.source} container names ${login.envDatabase}, not ${database}`)
    }
}

// Log in as the user and read its own grants: a failed login, or a grant short of what the step needs, refuses,
// naming the user and the privilege. The password is cut out of any client error before it is quoted.
async function checkServiceLogin(target, login, needed, database, table = null) {
    let text
    try {
        text = await executeDockerMariaDbCommandAs(target.containerId, login.user, login.password, CURRENT_USER_GRANTS_SQL, '-B -N')
    } catch (err) {
        const detail = String((err && err.message) || err).split(login.password).join('<redacted>')
        throw new Error(`${login.prefix}_DB_USER ${login.user} does not log in to ${target.containerName} (${detail})`)
    }
    const { missing, matched } = grantedPrivileges(String(text).split(/\r?\n/), needed, database, table)
    const on = table ? `${database}.${table}` : database
    if (missing.length) throw new Error(`${login.prefix}_DB_USER ${login.user} has no ${missing.join(' or ')} grant on ${on}`)
    login.database = on
    login.grants = matched
    return login
}

// The hub user the price fence clear runs as. The clear reads HUB_DB_NAME from this CLI's hub config and runs a
// DELETE on its fence table, so that is the grant checked. Like the clear itself, a hub config with no name, or a
// stack whose hub uses another database, skips the clear (which prints the hand-run statement) rather than refuse.
async function resolveHubLogin(target, sources) {
    const cfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    const hubDbName = cfg && cfg['HUB_DB_NAME']
    if (!hubDbName) return { hubLogin: null, hubNote: 'the hub configuration carries no HUB_DB_NAME' }
    assertSafeDbIdentifier(hubDbName, 'database name')
    const login = await readLogin(sources, 'HUB')
    if (login.envDatabase && login.envDatabase !== hubDbName) {
        return { hubLogin: null, hubNote: `HUB_DB_NAME in the ${login.source} container names ${login.envDatabase}, not ${hubDbName}` }
    }
    return { hubLogin: await checkServiceLogin(target, login, ['DELETE'], hubDbName, PRICE_FENCE_TABLE), hubNote: null }
}

// Resolve every login a service-mode reset needs, before anything is stopped: each target database's own user,
// which must log in and hold DROP and CREATE on it, and the hub user when the indexer reset will clear the fence.
// `databases` lines up with `modules`, as resolveResetTargets builds it.
async function resolveServiceLogins({ containerName, containerId, modules, databases, findServiceContainer }) {
    const target = { containerName, containerId }
    const sources = await serviceEnvSources(findServiceContainer)
    const logins = {}
    for (let i = 0; i < modules.length; i++) {
        const login = await readLogin(sources, loginPrefixFor(modules[i]))
        checkLoginNamesDatabase(login, databases[i])
        logins[databases[i]] = await checkServiceLogin(target, login, ['DROP', 'CREATE'], databases[i])
    }
    const hub = modules.includes(XChainService.XCHAIN_INDEXER) ? await resolveHubLogin(target, sources) : { hubLogin: null, hubNote: null }
    return { logins, ...hub }
}

// What a service-mode target logs in as and the grants that allowed it: users and privileges, never a password.
function serviceAuthReport(target) {
    const lines = [`No root login works on ${target.containerName} (${target.rootRefusal}), so each step runs as the stack's own database user:`]
    for (const login of [...Object.values(target.logins), ...(target.hubLogin ? [target.hubLogin] : [])]) {
        lines.push(`  ${login.database}: ${login.user} (${login.prefix}_DB_USER from the ${login.source} container), granted ${login.grants.join('; ')}`)
    }
    if (target.hubNote) lines.push(`  hub price fence: not cleared by this reset (${target.hubNote}); it prints the statement to run by hand`)
    return lines
}

// The client call for one statement on the named server: as root when a root logged in, else as the login that
// owns `database` (null for the hub fence clear). A missing login throws rather than fall back to another user.
function namedTargetRunner(namedTarget, database) {
    if (!namedTarget.logins) {
        return (sql, options) => executeDockerMariaDbCommand(namedTarget.containerId, namedTarget.rootPassword, sql, options)
    }
    const login = database === null ? namedTarget.hubLogin : namedTarget.logins[database]
    if (!login) throw new Error(`no ${database === null ? 'hub' : database} login was resolved on ${namedTarget.containerName}`)
    return (sql, options) => executeDockerMariaDbCommandAs(namedTarget.containerId, login.user, login.password, sql, options)
}

module.exports = { resolveServiceLogins, serviceAuthReport, namedTargetRunner, configureDependencies }
