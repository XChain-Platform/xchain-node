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
let { getDockerContainerImageName, validatePort } = require('../config_service')
let { getStatusFromContainer, probeContainerPresenceByName } = require('../docker_service')
let config = require('../../config')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, execFileAsync, DB_MODULE_NAME, sleep, dockerMariadbArgs, mariadbEnv, PING_SQL, getDockerContainerImageName, validatePort, getStatusFromContainer, probeContainerPresenceByName, config } = dependencies)
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
    const configuredPort = config.hostEnv().XCHAIN_NODE_DB_HOST_PORT
    if (configuredPort && !validatePort(configuredPort)) {
        throw new Error("Invalid port value in configuration: XCHAIN_NODE_DB_HOST_PORT=" + configuredPort)
    }
    try {
        const containerName = getDockerContainerImageName(DB_MODULE_NAME, "", "")
        const { stdout } = await execFileAsync('docker', ['port', containerName, '3306/tcp'])
        const lines = stdout.trim().split('\n').filter(Boolean)
        for (const line of lines) {
            const match = line.match(/:(\d+)$/)
            if (match) return parseInt(match[1], 10)
        }
        return configuredPort ? parseInt(configuredPort, 10) : XCHAIN_NODE_DB_DEFAULT_PORT
    } catch {
        return configuredPort ? parseInt(configuredPort, 10) : XCHAIN_NODE_DB_DEFAULT_PORT
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
//
// The container id is resolved on every attempt. Right after `docker run` the
// inspect can miss the new container, and an id read once before the loop made
// every retry exec against nothing, so the whole budget ran out on a container
// that came up seconds later. An attempt with no container counts as not ready.
async function checkIfDatabaseIsReady(user, userPassword, database = null, { tries = 10, retryDelay = 10000 } = {}) {
    let remaining = tries
    while (remaining > 0) {
        const mariadbContainerId = await getDatabaseContainerId()
        if (mariadbContainerId) {
            try {
                const args = dockerMariadbArgs(mariadbContainerId, ['mariadb', '-u', user], { interactive: true })
                if (database) args.push('-D', database)
                args.push('-e', PING_SQL)
                await execFileAsync('docker', args, { env: mariadbEnv(userPassword) })
                return true
            } catch { /* not accepting connections yet */ }
        }
        remaining--
        if (remaining > 0) await sleep(retryDelay)
    }
    return false
}

// How long a FRESH datadir gets to accept its first root login: 60 x 5 s. The
// image initialises the datadir and restarts its server before it listens, which
// on a busy disk ran past the 10 x 10 s wait of the first caller to touch it, and
// install stopped on "MariaDB is not responding" against a database seconds away
// from ready. Waited once, straight after `docker run`, so every later caller
// meets a running server.
const FIRST_BOOT_READY = { tries: 60, retryDelay: 5000 }

async function waitForFirstBoot(containerName, mariadbRootPassword) {
    if (await checkIfDatabaseIsReady("root", mariadbRootPassword, null, FIRST_BOOT_READY)) return
    const waitedMin = Math.round(FIRST_BOOT_READY.tries * FIRST_BOOT_READY.retryDelay / 60000)
    throw new Error("MariaDB container " + containerName + " did not accept connections within " + waitedMin +
        " min of starting; check `docker logs " + containerName + "` and re-run install")
}

module.exports = { XCHAIN_NODE_DB_HOST, XCHAIN_NODE_DB_DEFAULT_PORT, FIRST_BOOT_READY, getDatabaseContainerId, getDatabaseContainerPresence, getDatabaseHostPort, checkIfDatabaseModuleExists, checkIfDatabaseIsReady, waitForFirstBoot, configureDependencies }
