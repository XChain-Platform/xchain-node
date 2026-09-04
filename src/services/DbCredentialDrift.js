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
 * XChain Node - DB Credential Drift
 *
 * Guards the one gap setDatabaseParameters cannot see. That function rotates a
 * per-coin/network MariaDB account to the password THIS install's config file
 * carries, but a container is a credential store of its own: its password was
 * frozen into its env by the `docker run` that created it. Two installs sharing
 * one Docker daemon and one MariaDB (a source checkout plus a scratch clone,
 * each with its own config/<coin>-<network>) therefore pin different passwords
 * for the SAME account, and whichever provisions last silently locks the other
 * install's container out; a container stuck in a resulting restart loop also
 * loses its Docker DNS entry, so the outage can surface as ENOTFOUND rather
 * than as a credential fault.
 *
 * The check compares each RUNNING container's frozen env against the password
 * about to be written and fails closed BEFORE any ALTER USER runs, so a refusal
 * leaves the stack exactly as it was. Values are never logged, only compared.
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const { XChainService, HUB_MODULE_NAME } = require('../config/constants')
const { getDockerContainerImageName } = require('./ConfigService')

// Escape hatch for the operator who knows the lagging container is about to be
// recreated anyway (the `recreate` remediation itself does not need it, because
// it rebuilds EVERY named container before provisioning runs; a single-module
// `update` converges only its own container and is refused up front instead).
const DRIFT_OVERRIDE_ENV = 'XCHAIN_NODE_ALLOW_DB_CREDENTIAL_DRIFT'

// Tags the refusal so callers can tell it apart from a docker/network failure.
const DRIFT_ERROR_CODE = 'DB_CREDENTIAL_DRIFT'

// Which container env key authenticates with which per-coin/network account.
// The indexer appears twice on purpose: it opens its own DB with
// INDEXER_DB_PASS and the decoder's DB with DECODER_DB_PASS, so a decoder-account
// rotation locks out the indexer as surely as it locks out the decoder.
const ACCOUNT_CONSUMERS = [
    { module: XChainService.XCHAIN_DECODER, envKey: 'DECODER_DB_PASS', account: 'decoder' },
    { module: XChainService.XCHAIN_INDEXER, envKey: 'DECODER_DB_PASS', account: 'decoder' },
    { module: XChainService.XCHAIN_INDEXER, envKey: 'INDEXER_DB_PASS', account: 'indexer' }
]

// Env keys by which a container declares the SHARED hub account it authenticates with.
const HUB_USER_ENV_KEY = 'HUB_DB_USER'
const HUB_PASS_ENV_KEY = 'HUB_DB_PASS'

/**
 * Compare the passwords a provision is about to write against the passwords the
 * running containers already carry. Pure: no docker, no DB, no logging.
 *
 * @param {{decoder?: string, indexer?: string}} intended  Passwords this install will write.
 * @param {Array<{module: string, name: string, env: Object<string,string>}>} containers Running containers.
 * @returns {Array<{container: string, module: string, envKey: string, account: string}>} One row per lockout.
 */
function findDbCredentialDrift(intended, containers) {
    const drift = []
    for (const container of containers || []) {
        for (const consumer of ACCOUNT_CONSUMERS) {
            if (container.module !== consumer.module) continue
            const target = intended ? intended[consumer.account] : undefined
            // Nothing to compare when either side is absent: an install that
            // does not set the key is not claiming a value for it, and a
            // container built before the key existed is not authenticating with
            // it either. Only a present-and-different pair is a lockout.
            if (target === undefined || target === null || target === '') continue
            const live = container.env ? container.env[consumer.envKey] : undefined
            if (live === undefined || live === null || live === '') continue
            if (live !== target) {
                drift.push({
                    container: container.name,
                    module:    container.module,
                    envKey:    consumer.envKey,
                    account:   consumer.account
                })
            }
        }
    }
    return drift
}

/**
 * Render the refusal. Names the containers and the remediation; never the values,
 * because this string reaches logs, CI output and pasted bug reports.
 *
 * @param {string} coin
 * @param {string} network
 * @param {Array<{container: string, module: string, envKey: string, account: string}>} drift
 * @param {string[]} [alsoRecreate] Modules the caller skipped that must still be recreated with the rest.
 * @returns {string}
 */
function formatDbCredentialDriftError(coin, network, drift, alsoRecreate = []) {
    const lines = drift.map(d =>
        `  - ${d.container} carries a ${d.envKey} that differs from this install's config ` +
        `(${d.account} account)`
    )
    // A skipped module still belongs in the remediation: the accounts are shared,
    // so recreating only the containers that happened to be inspected converges
    // half the stack and leaves the other half locked out (uuid:cb0bd3be).
    const modules = [...new Set([...drift.map(d => d.module), ...alsoRecreate])]
    return (
        `Refusing to rotate the ${coin} ${network} MariaDB accounts: a running container was built ` +
        `from a DIFFERENT config store and would be locked out (ER_ACCESS_DENIED) the moment the ` +
        `password is written.\n` +
        lines.join('\n') + '\n' +
        `Nothing has been changed. Point both installs at one config/${coin}-${network}, then run ` +
        `\`xchain-node recreate ${modules.join(' ')} ${coin} ${network}\` from the install that owns ` +
        `the stack. Set ${DRIFT_OVERRIDE_ENV}=1 to rotate anyway.`
    )
}

/**
 * Compare the SHARED hub password a provision is about to write against the
 * passwords the running containers already carry. Pure: no docker, no logging.
 *
 * @param {{user?: string, pass?: string}} intended  The hub account this install will write.
 * @param {Array<{name: string, env: Object<string,string>}>} containers Running containers.
 * @returns {Array<{container: string, envKey: string, account: string}>} One row per lockout.
 */
function findHubDbCredentialDrift(intended, containers) {
    const drift = []
    const user = intended ? intended.user : undefined
    const pass = intended ? intended.pass : undefined
    // Claim nothing when this install names no account or no password for it.
    if (!user || !pass) return drift
    for (const container of containers || []) {
        const env = container.env || {}
        // Keys on the ACCOUNT, not the module: the indexer points HUB_DB_USER at its
        // own account, so a module-keyed row false-alarms on it (uuid:a48aab2c).
        if (env[HUB_USER_ENV_KEY] !== user) continue
        const live = env[HUB_PASS_ENV_KEY]
        // Absent on either side is no claim, the same rule findDbCredentialDrift uses.
        if (live === undefined || live === null || live === '') continue
        if (live !== pass) {
            drift.push({ container: container.name, envKey: HUB_PASS_ENV_KEY, account: user })
        }
    }
    return drift
}

/**
 * Render the shared-account refusal. The coin/network formatter above would print
 * blanks here, because the hub is a shared service with neither.
 *
 * @param {Array<{container: string, envKey: string, account: string}>} drift
 * @returns {string}
 */
function formatHubDbCredentialDriftError(drift) {
    const lines = drift.map(d =>
        `  - ${d.container} carries a ${d.envKey} that differs from this install's config ` +
        `(shared '${d.account}' account)`
    )
    return (
        `Refusing to rotate the shared hub MariaDB account: a running container was built from a ` +
        `DIFFERENT config store and would be locked out (ER_ACCESS_DENIED) the moment the password ` +
        `is written.\n` +
        lines.join('\n') + '\n' +
        `Nothing has been changed. Point both installs at one config/hub.local, then run ` +
        `\`xchain-node recreate ${HUB_MODULE_NAME}\` from the install that owns the stack. ` +
        `Set ${DRIFT_OVERRIDE_ENV}=1 to rotate anyway.`
    )
}

/**
 * List every running container's name, or [] when docker cannot answer.
 * Tolerant by design: an unreadable daemon is not drift.
 *
 * @param {{execFileAsync?: Function}} [deps]
 * @returns {Promise<string[]>}
 */
async function listRunningContainerNames(deps = {}) {
    const runDocker = deps.execFileAsync || execFileAsync
    try {
        const { stdout } = await runDocker('docker', ['ps', '--format', '{{.Names}}'])
        return String(stdout).split('\n').map(name => name.trim()).filter(Boolean)
    } catch {
        return []
    }
}

/**
 * Fail closed when a running holder of the shared hub account would be locked out
 * by the password this install is about to write.
 *
 * @param {{user?: string, pass?: string}} intended
 * @param {{execFileAsync?: Function, env?: Object, excludeContainers?: string[]}} [deps]
 * @returns {Promise<Array>} the drift rows (empty when clean, or when overridden)
 */
async function assertNoHubDbCredentialDrift(intended, deps = {}) {
    const env = deps.env || process.env
    // Sweeps the whole daemon instead of deriving names: the hub has no coin/network
    // to derive from, and a co-located install runs its own under another NODE_PREFIX.
    const exclude = new Set(Array.isArray(deps.excludeContainers) ? deps.excludeContainers : [])
    const containers = []
    for (const name of await listRunningContainerNames(deps)) {
        if (exclude.has(name)) continue
        const containerEnv = await readContainerEnv(name, deps)
        if (containerEnv) containers.push({ name, env: containerEnv })
    }

    const drift = findHubDbCredentialDrift(intended, containers)
    if (drift.length === 0) return drift

    if (env[DRIFT_OVERRIDE_ENV] === '1') {
        console.log(formatHubDbCredentialDriftError(drift))
        console.log(`${DRIFT_OVERRIDE_ENV}=1 is set; rotating anyway.`)
        return drift
    }
    const error = new Error(formatHubDbCredentialDriftError(drift))
    error.code = DRIFT_ERROR_CODE
    error.drift = drift
    throw error
}

/**
 * Read a running container's env as a plain object, or null when the container
 * does not exist. Tolerant by design: a missing container is not drift.
 *
 * @param {string} name
 * @param {{execFileAsync?: Function}} [deps]
 * @returns {Promise<Object<string,string>|null>}
 */
async function readContainerEnv(name, deps = {}) {
    const runDocker = deps.execFileAsync || execFileAsync
    let stdout
    try {
        ({ stdout } = await runDocker('docker', ['inspect', '--type', 'container', '--format', '{{json .Config.Env}}', name]))
    } catch {
        return null
    }
    let parsed
    try {
        parsed = JSON.parse(String(stdout).trim())
    } catch {
        return null
    }
    if (!Array.isArray(parsed)) return null
    const env = {}
    for (const entry of parsed) {
        const eqIndex = String(entry).indexOf('=')
        if (eqIndex <= 0) continue
        env[String(entry).substring(0, eqIndex)] = String(entry).substring(eqIndex + 1)
    }
    return env
}

/**
 * Fail closed when a running decoder/indexer container would be locked out by the
 * passwords this install is about to provision.
 *
 * @param {string} coin
 * @param {string} network
 * @param {{decoder?: string, indexer?: string}} intended
 * @param {{execFileAsync?: Function, env?: Object, excludeModules?: string[]}} [deps]
 * @returns {Promise<Array>} the drift rows (empty when clean, or when overridden)
 */
async function assertNoDbCredentialDrift(coin, network, intended, deps = {}) {
    const env = deps.env || process.env
    // Skip the container a caller is about to replace from THIS install's config:
    // its frozen password is about to stop existing, so counting it would refuse
    // the very rebuild that clears the drift (uuid:cb0bd3be).
    const excludeModules = Array.isArray(deps.excludeModules) ? deps.excludeModules : []
    const modules = [...new Set(ACCOUNT_CONSUMERS.map(c => c.module))]
        .filter(m => !excludeModules.includes(m))
    const containers = []
    for (const module of modules) {
        const name = getDockerContainerImageName(module, coin, network)
        const containerEnv = await readContainerEnv(name, deps)
        if (containerEnv) containers.push({ module, name, env: containerEnv })
    }

    const drift = findDbCredentialDrift(intended, containers)
    if (drift.length === 0) return drift

    if (env[DRIFT_OVERRIDE_ENV] === '1') {
        console.log(formatDbCredentialDriftError(coin, network, drift, excludeModules))
        console.log(`${DRIFT_OVERRIDE_ENV}=1 is set; rotating anyway.`)
        return drift
    }
    const error = new Error(formatDbCredentialDriftError(coin, network, drift, excludeModules))
    error.code = DRIFT_ERROR_CODE
    error.drift = drift
    throw error
}

/**
 * Whether an error came from the drift guard. Callers use it to suppress their own
 * fallback diagnosis, which would otherwise blame the wrong layer.
 *
 * @param {*} err
 * @returns {boolean}
 */
function isDbCredentialDriftError(err) {
    return !!err && err.code === DRIFT_ERROR_CODE
}

module.exports = {
    DRIFT_OVERRIDE_ENV,
    DRIFT_ERROR_CODE,
    ACCOUNT_CONSUMERS,
    findDbCredentialDrift,
    formatDbCredentialDriftError,
    readContainerEnv,
    assertNoDbCredentialDrift,
    findHubDbCredentialDrift,
    formatHubDbCredentialDriftError,
    listRunningContainerNames,
    assertNoHubDbCredentialDrift,
    isDbCredentialDriftError
}
