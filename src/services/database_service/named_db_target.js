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
 * A MariaDB container named by the operator, for a stack that runs its own
 ********************************************************************/

let { execFile } = require('child_process')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let { assertSafeDbIdentifier } = require('../../utils/sql_safety')
let { schemaExistsSql } = require('../../db/information_schema')
let { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
let { executeDockerMariaDbCommand } = require('./mariadb_exec')
let { resolveResetTargets } = require('./reset_databases')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, execFileAsync, assertSafeDbIdentifier, schemaExistsSql, dockerMariadbArgs, mariadbEnv, executeDockerMariaDbCommand, resolveResetTargets } = dependencies)
}

// Docker's own container-name grammar, checked before the name reaches any argv.
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

// The env names the official mariadb and mysql images take their root password from.
const ROOT_PASSWORD_VARS = ['MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD']

async function findNamedContainerId(containerName) {
    if (!CONTAINER_NAME.test(String(containerName || ''))) {
        throw new Error(`'${containerName}' is not a valid docker container name`)
    }
    let stdout
    try {
        ({ stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', containerName]))
    } catch (err) {
        throw new Error(`docker inspect ${containerName} failed (${(err && err.message) || err})`)
    }
    const id = String(stdout).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`docker inspect ${containerName} returned no container id`)
    return id
}

// Read the root password the container was started with, and keep it only if it logs in. It is never
// cached or saved: the CLI's stored root belongs to its bundled server, and this one is another server's.
async function rootPasswordForContainer(containerId, containerName) {
    for (const name of ROOT_PASSWORD_VARS) {
        try {
            const { stdout } = await execFileAsync('docker', ['exec', containerId, 'printenv', name])
            const value = String(stdout).replace(/\r?\n$/, '')
            if (!value) continue
            const ping = await execFileAsync('docker', dockerMariadbArgs(containerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(value) })
            if (String(ping.stdout).includes('mysqld is alive')) return value
        } catch { /* unset in this container, or it did not log in: try the next name */ }
    }
    throw new Error(`no root password in ${containerName}'s environment (${ROOT_PASSWORD_VARS.join(', ')}) logs in to it`)
}

// Resolve everything the reset's DB steps need from the named server, before anything is stopped. Each target
// database must already exist there: a name that differs from the stack's own would otherwise DROP nothing and
// CREATE an empty database beside the live one, and the reset would report success.
async function resolveNamedDatabaseTarget(containerName, coin, network, modules) {
    const containerId = await findNamedContainerId(containerName)
    const rootPassword = await rootPasswordForContainer(containerId, containerName)
    const databases = await resolveResetTargets(coin, network, modules)
    for (const dbName of databases) {
        assertSafeDbIdentifier(dbName, 'database name')
        const found = await executeDockerMariaDbCommand(containerId, rootPassword, schemaExistsSql(dbName), '-B -N')
        if (parseInt(String(found).trim(), 10) !== 1) {
            throw new Error(`${containerName} holds no database ${dbName}, so this is not the server that stack uses`)
        }
    }
    return { containerName, containerId, rootPassword, databases }
}

module.exports = { resolveNamedDatabaseTarget, configureDependencies }
