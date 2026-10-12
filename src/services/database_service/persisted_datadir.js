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
 * Root password for a DB container recreated over a persisted datadir
 ********************************************************************/

const fs = require('fs')
const path = require('path')
let { execFile } = require('child_process')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let { Password } = require('enquirer')
let { setDbRootPassword } = require('../../state')
let { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
let { sleep } = require('../../utils/helpers')
let config = require('../../config')
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { loadDbRootPassword, saveDbRootPassword } = require('../credentials_service')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, execFileAsync, Password, setDbRootPassword, dockerMariadbArgs, mariadbEnv, sleep, config, logger, loadDbRootPassword, saveDbRootPassword } = dependencies)
}

// Say whether the datadir a new DB container mounts already holds a database ('initialised') or
// will be initialised from MYSQL_ROOT_PASSWORD ('fresh'). The mariadb image ignores that variable
// when <datadir>/mysql exists, so the old root password stays in force there.
function dbDatadirState() {
    const dir = config.XCHAIN_NODE_DB_DATA_DIR
    if (!dir) return 'fresh'
    // Count a docker named volume as initialised: it persists and cannot be inspected from here.
    if (!path.isAbsolute(dir)) return 'initialised'
    try {
        fs.statSync(path.join(dir, 'mysql'))
        return 'initialised'
    } catch (err) {
        // Only a confirmed absence is fresh; EACCES and the like may hide an initialised datadir.
        return err && err.code === 'ENOENT' ? 'fresh' : 'initialised'
    }
}

// Pick the root password for a container recreated over an initialised datadir, saving nothing:
// it is checked against the running container (confirmPersistedDatadirRootPassword) before it is stored.
async function rootPasswordForPersistedDatadir() {
    const dir = config.XCHAIN_NODE_DB_DATA_DIR
    const stored = loadDbRootPassword()
    const envPassword = config.XCHAIN_NODE_DB_ROOT_PASSWORD
    if (stored && envPassword && stored !== envPassword) {
        logger.warn('WARNING: XCHAIN_NODE_DB_ROOT_PASSWORD differs from the stored root password; the stored copy is '
            + 'tried first and both are checked once the MariaDB container is up.')
    }
    logger.info(`The MariaDB datadir at ${dir} already holds a database, so its existing root password stays in `
        + 'force; the image ignores MYSQL_ROOT_PASSWORD on an initialised datadir.')
    let candidate = stored || envPassword
    if (!candidate) {
        if (!process.stdin.isTTY) {
            throw new Error(`The MariaDB datadir at ${dir} (XCHAIN_NODE_DB_DATA_DIR) already holds a database, so its `
                + 'existing root password is needed, and neither credentials.json nor XCHAIN_NODE_DB_ROOT_PASSWORD '
                + 'supplies one and there is no TTY to prompt on. Set XCHAIN_NODE_DB_ROOT_PASSWORD to that '
                + 'datadir\'s root password and re-run. No root password was set or saved.')
        }
        candidate = await new Password({ name: 'password',
            message: `The MariaDB datadir at ${dir} already holds a database. Type its existing root password` }).run()
    }
    setDbRootPassword(candidate)
    return candidate
}

// Ask the DB container whether `password` is root's: 'yes', 'no' (the server refused it) or 'down'.
async function probeRootPassword(containerId, password) {
    try {
        const { stdout, stderr } = await execFileAsync('docker',
            dockerMariadbArgs(containerId, ['mariadb-admin', '-u', 'root', 'ping']), { env: mariadbEnv(password) })
        if (String(stdout).includes('mysqld is alive')) return 'yes'
        return /access denied/i.test(String(stderr) + String(stdout)) ? 'no' : 'down'
    } catch (err) {
        return /access denied/i.test(String(err && (err.stderr || err.message))) ? 'no' : 'down'
    }
}

// Store a root password for a container created over an initialised datadir only once it
// authenticates, trying the chosen one, then the stored copy, then XCHAIN_NODE_DB_ROOT_PASSWORD.
async function confirmPersistedDatadirRootPassword(containerId, chosen, { tries = 30, retryDelay = 2000 } = {}) {
    const candidates = [chosen, loadDbRootPassword(), config.XCHAIN_NODE_DB_ROOT_PASSWORD]
        .filter((p, i, all) => p && all.indexOf(p) === i)
    for (const candidate of candidates) {
        let answer = 'down'
        for (let left = tries; left > 0 && answer === 'down'; left--) {
            answer = await probeRootPassword(containerId, candidate)
            if (answer === 'down' && left > 1) await sleep(retryDelay)
        }
        if (answer === 'down') {
            throw new Error('The new MariaDB container did not answer a root ping, so its root password could not be '
                + 'checked; credentials.json was left untouched. Check `docker logs` for the database container.')
        }
        if (answer === 'yes') {
            setDbRootPassword(candidate)
            saveDbRootPassword(candidate)
            return candidate
        }
    }
    throw new Error(`The MariaDB datadir at ${config.XCHAIN_NODE_DB_DATA_DIR} already holds a database whose root `
        + 'password is neither the stored copy nor XCHAIN_NODE_DB_ROOT_PASSWORD; credentials.json was left '
        + 'untouched. Set XCHAIN_NODE_DB_ROOT_PASSWORD to that datadir\'s root password and re-run.')
}

module.exports = { dbDatadirState, rootPasswordForPersistedDatadir, confirmPersistedDatadirRootPassword, configureDependencies }
