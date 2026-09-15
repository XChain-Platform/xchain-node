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
let mariadb = require('mariadb')
let { Password, Input, NumberPrompt } = require('enquirer')
let { EXTERNAL_DB_HOST, EXTERNAL_DB_PORT, EXTERNAL_DB_ROOT_USER } = require('../../config')
let { PING_SQL } = require('../../db/connectivity')
let { validatePort } = require('../config_service')
let config = require('../../config')
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { hasExternalDbConfig, loadExternalDbConfig, saveExternalDbConfig } = require('../credentials_service')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, mariadb, Password, Input, NumberPrompt, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT, EXTERNAL_DB_ROOT_USER, PING_SQL, validatePort, config, getLogger, logger, hasExternalDbConfig, loadExternalDbConfig, saveExternalDbConfig } = dependencies)
}


// Returns full external-DB config { host, port, root_user, root_password }.
// Precedence: env vars (all four) → credentials.json `externalDb` block →
// interactive prompt → verify → persist. Cached in state.dbRootPassword for
// the rest of the process so we don't re-prompt within a single CLI run.
// Parse + validate an external-DB port at the single resolver chokepoint. Every
// other operator/config-supplied port is validatePort-gated before it reaches a
// child process (DB_PORT here, NODE_*_PORT in NodeService, the portArgs loop in
// ModuleService); the external-DB port was the one that escaped. A malformed
// value would otherwise propagate as NaN/0/70000 into spawn('mariadb'/'mariadb-
// dump', '-P', ...) and be baked into every provisioned container's DECODER_/
// INDEXER_/HUB_DB_PORT env via the ConfigService EXTERNAL_DB rewrite, surfacing
// far from its cause as an opaque driver error. Fail loud at config resolution.
function resolveExternalDbPort(raw) {
    const port = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    if (!validatePort(port)) {
        throw new Error('Invalid external-DB port: ' + String(raw)
            + ' (set XCHAIN_NODE_EXTERNAL_DB_PORT to an integer 1-65535)')
    }
    return port
}

async function getExternalDbConfig() {
    // Fast path: env vars supply everything for headless flows
    if (config.XCHAIN_NODE_EXTERNAL_DB_HOST
        && config.XCHAIN_NODE_EXTERNAL_DB_PORT
        && config.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER
        && config.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD) {
        return {
            host:          config.XCHAIN_NODE_EXTERNAL_DB_HOST,
            port:          resolveExternalDbPort(config.XCHAIN_NODE_EXTERNAL_DB_PORT),
            root_user:     config.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
            root_password: config.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
        }
    }

    // Saved config wins next
    if (hasExternalDbConfig()) {
        const saved = loadExternalDbConfig()
        if (saved) {
            // Verify still works; bad creds (or an out-of-range persisted port)
            // mean we should re-prompt rather than propagate a bad value.
            try {
                saved.port = resolveExternalDbPort(saved.port)
                await pingMariaDb(saved)
                return saved
            } catch {
                logger.info("Saved external-DB credentials no longer work. Please re-enter them.")
            }
        }
    }

    // Non-interactive run (cron, ssh BatchMode, CI): the prompt loop below would
    // block forever on a stdin that never answers, and this resolver is reached
    // from preCheck and ensureDatabasePool INSIDE the CLI command lock, so the
    // hang wedges every later xchain-node command on the host rather than just
    // this one. Same fail-fast the bundled-DB path already does in
    // askMariadbRootPassword. Placed AFTER the env and saved-credential branches
    // so both headless success paths keep working untouched.
    if (!process.stdin.isTTY) {
        throw new Error(
            'External-DB connection details are needed but there is no TTY to prompt on. ' +
            'Set ALL FOUR of XCHAIN_NODE_EXTERNAL_DB_HOST, XCHAIN_NODE_EXTERNAL_DB_PORT, ' +
            'XCHAIN_NODE_EXTERNAL_DB_ROOT_USER and XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD ' +
            '(a partial set does not qualify for the headless path), or run any xchain-node ' +
            'command once interactively so the verified details are saved to ' +
            '~/.xchain-node/credentials.json for later runs.'
        )
    }
    return promptForExternalDbConfig()
}

async function promptForExternalDbConfig() {
    // Interactive prompt
    logger.info("\nExternal MariaDB configuration (XCHAIN_NODE_EXTERNAL_DB=1)")
    logger.info("Provide the connection details for the host-native MariaDB this node should use.\n")

    let cfg = null
    while (!cfg) {
        const hostPrompt = new Input({ name: 'host', message: 'Host', initial: EXTERNAL_DB_HOST })
        const host = await hostPrompt.run()
        const portPrompt = new NumberPrompt({ name: 'port', message: 'Port', initial: EXTERNAL_DB_PORT })
        const port = await portPrompt.run()
        const userPrompt = new Input({ name: 'root_user', message: 'Root user', initial: EXTERNAL_DB_ROOT_USER })
        const root_user = await userPrompt.run()
        const passPrompt = new Password({ name: 'root_password', message: 'Root password' })
        const root_password = await passPrompt.run()

        try {
            const candidate = { host: String(host).trim(), port: resolveExternalDbPort(port), root_user: String(root_user).trim(), root_password }
            await pingMariaDb(candidate)
            saveExternalDbConfig(candidate)
            logger.info("External MariaDB connection verified. Saved to ~/.xchain-node/credentials.json")
            cfg = candidate
        } catch (err) {
            logger.info("Could not connect: " + (err.message || err) + ". Please try again.")
        }
    }
    return cfg
}

// Lightweight ping: open a one-shot connection, SELECT 1, close.
async function pingMariaDb({ host, port, root_user, root_password }) {
    const conn = await mariadb.createConnection({
        host, port: Number(port), user: root_user, password: root_password,
        connectTimeout: 5_000
    })
    try {
        await conn.query(PING_SQL)
    } finally {
        try { await conn.end() } catch {}
    }
}

// Resolve the external config and prove the server answers, REPORTING failure
// instead of throwing. A caller standing in front of a destructive section needs
// to abort cleanly and return; an exception unwinding out of it skips the
// restart pass and leaves the stack down. Swallows the
// non-interactive throw from getExternalDbConfig for the same reason. Never
// returns or logs the password.
async function pingExternalDatabase() {
    let cfg = null
    try {
        cfg = await getExternalDbConfig()
    } catch (err) {
        return { ok: false, host: null, port: null, error: (err && err.message) || String(err) }
    }
    try {
        await pingMariaDb(cfg)
        return { ok: true, host: cfg.host, port: cfg.port }
    } catch (err) {
        return { ok: false, host: cfg.host, port: cfg.port, error: (err && err.message) || String(err) }
    }
}

module.exports = { resolveExternalDbPort, getExternalDbConfig, pingMariaDb, pingExternalDatabase, configureDependencies }
