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
 * MariaDB management: build, configure users, check readiness
 ********************************************************************/


let { execFile } = require('child_process')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let { DB_MODULE_NAME } = require('../../config')
let { sleep } = require('../../utils/helpers')
let { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
let { PING_SQL } = require('../../db/connectivity')
let { getDockerContainerImageName } = require('../config_service')
let { getStatusFromContainer, probeContainerPresenceByName } = require('../docker_service')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, execFileAsync, DB_MODULE_NAME, sleep, dockerMariadbArgs, mariadbEnv, PING_SQL, getDockerContainerImageName, getStatusFromContainer, probeContainerPresenceByName } = dependencies)
}


const XCHAIN_NODE_DB_HOST = "127.0.0.1"
const XCHAIN_NODE_DB_DEFAULT_PORT = 13306

async function getDatabaseContainerId() {
    try {
        const containerName = getDockerContainerImageName(DB_MODULE_NAME, "", "")
        const { stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', containerName])
        const id = stdout.trim()
        if (/^[a-f0-9]{64}$/.test(id)) return id
        return null
    } catch {
        return null
    }
}

// Tri-state presence of the MariaDB container: 'exists' | 'gone' | 'unknown'.
// getDatabaseContainerId() above answers null for BOTH "no such container" and
// "the inspect failed", which is fine for a read that degrades gracefully and
// wrong for a caller about to authorise a destructive path. Those callers ask
// here, where only docker SAYING "no such container" counts as absence.
async function getDatabaseContainerPresence() {
    return probeContainerPresenceByName(getDockerContainerImageName(DB_MODULE_NAME, "", ""))
}

async function getDatabaseHostPort() {
    try {
        const containerName = getDockerContainerImageName(DB_MODULE_NAME, "", "")
        const { stdout } = await execFileAsync('docker', ['port', containerName, '3306/tcp'])
        const lines = stdout.trim().split('\n').filter(Boolean)
        for (const line of lines) {
            const match = line.match(/:(\d+)$/)
            if (match) return parseInt(match[1], 10)
        }
        return XCHAIN_NODE_DB_DEFAULT_PORT
    } catch {
        return XCHAIN_NODE_DB_DEFAULT_PORT
    }
}
async function checkIfDatabaseModuleExists(coin, network) {
    try {
        const dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) return null
        const containerStatus = await getStatusFromContainer(dbContainerId)
        if (("State" in containerStatus) && ("Status" in containerStatus["State"])) {
            return dbContainerId
        } else {
            return null
        }
    } catch {
        return null
    }
}

// The 10x10s default is a POST-`docker run` readiness wait: mariadb takes tens of
// seconds to accept connections on a cold container. A caller using this to answer
// "do these credentials still work" is asking a different question, whose negative
// answer (ER_ACCESS_DENIED, unknown database) is not transient, so it must be able
// to buy a shorter budget instead of paying ~100s to learn it. Same reasoning the
// env-override ping and the provisioning precheck already act on above.
async function checkIfDatabaseIsReady(user, userPassword, database = null, { tries = 10, retryDelay = 10000 } = {}) {
    const mariadbContainerId = await getDatabaseContainerId()

    let remaining = tries
    while (remaining > 0) {
        try {
            const args = dockerMariadbArgs(mariadbContainerId, ['mariadb', '-u', user], { interactive: true })
            if (database) args.push('-D', database)
            args.push('-e', PING_SQL)
            await execFileAsync('docker', args, { env: mariadbEnv(userPassword) })
            return true
        } catch {
            remaining--
            if (remaining > 0) await sleep(retryDelay)
        }
    }
    return false
}

module.exports = { XCHAIN_NODE_DB_HOST, XCHAIN_NODE_DB_DEFAULT_PORT, getDatabaseContainerId, getDatabaseContainerPresence, getDatabaseHostPort, checkIfDatabaseModuleExists, checkIfDatabaseIsReady, configureDependencies }
