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
 * XChain Node - CLI
 * `reset hub-checkpoints`: rebuild checkpoint (and, on request, capability)
 * lineage on every rail hub, its federation peers and their indexer mirrors
 ********************************************************************/
const { execFile } = require('child_process')
const { promisify } = require('util')
const readline = require('readline')
const config = require('../config')
const dockerService = require('../services/docker_service')
const { stopModuleContainer } = require('../services/stop_budget_service')
const { statusChanged } = require('../services/status_service')
const { askMariadbRootPassword } = require('../services/database_service')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/docker_mariadb')

const HUB_CHECKPOINT_TABLES = Object.freeze([
    'state_checkpoints', 'snapshot_checkpoints', 'anchor_published_checkpoints'
])
const MIRROR_CHECKPOINT_TABLE = 'state_checkpoints'
// --with-capabilities: an indexer holds each mirrored capability row until a hub
// checkpoint proves it, so rows no checkpoint can prove wedge it for good.
const CAPABILITY_TABLE = 'capability_snapshots'
const execFileAsync = promisify(execFile)
const hubCheckpointDefaults = {
    execFileAsync,
    readline,
    stopContainer: dockerService.stopContainer,
    startContainer: dockerService.startContainer,
    getContainerStopSettings: dockerService.getContainerStopSettings,
    stopModuleContainer,
    statusChanged,
    // The same resolver every other CLI database step uses (config, container, stored
    // credentials); a rail database container need not carry MYSQL_ROOT_PASSWORD.
    rootPassword: () => askMariadbRootPassword(),
    EXTERNAL_DB: config.EXTERNAL_DB,
    HUB_MODULE_NAME: config.HUB_MODULE_NAME,
    INDEXER_MODULE_NAME: config.XChainService.XCHAIN_INDEXER
}

function commandOutput(result) {
    return String(result && typeof result === 'object' && 'stdout' in result ? result.stdout || '' : result || '')
}
function dockerName(container) {
    return String(container.Names || container.Name || '').replace(/^\//, '')
}
function running(container) {
    return String(container.State || '').toLowerCase() === 'running'
}
function safeDatabaseName(value, label) {
    const name = String(value || '')
    if (!/^[A-Za-z0-9_$]+$/.test(name)) throw new Error(`${label} is not a safe database identifier`)
    return name
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function parseContainerList(result) {
    return commandOutput(result).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
}
function railStacks(containers, deps) {
    const suffix = '-' + deps.HUB_MODULE_NAME
    const stacks = containers.filter(container => dockerName(container).endsWith(suffix)).map((hub) => {
        const prefix = dockerName(hub).slice(0, -suffix.length)
        const database = containers.find(container => dockerName(container) === prefix + '-database')
        if (!database) throw new Error(`reset hub-checkpoints: no database container found for ${dockerName(hub)}`)
        const escaped = escapeRegExp(prefix)
        const indexer = new RegExp('^' + escaped
            + '-(?:bitcoin|litecoin|dogecoin)-(?:mainnet|testnet|regtest)-xchain-indexer$')
        const mirrors = containers.filter(container => indexer.test(dockerName(container))
            || dockerName(container) === prefix + '-xchain-explorer')
        // Federation peers (<prefix>-xchain-hub-b, -c) move with the hub: one reset hub of a
        // quorum is a new fault. The one-letter suffix skips dated drill snapshots.
        const peer = new RegExp('^' + escaped + escapeRegExp(suffix) + '-[a-z]$')
        const peers = containers.filter(container => peer.test(dockerName(container)))
        return { hub, peers, database, mirrors }
    })
    if (!stacks.length) throw new Error('reset hub-checkpoints: no rail hub containers were found')
    return stacks
}
async function containerEnvironment(container, deps) {
    const id = container.ID || dockerName(container)
    const result = await deps.execFileAsync('docker', [
        'inspect', '--type', 'container', '--format', '{{json .Config.Env}}', id
    ])
    const entries = JSON.parse(commandOutput(result).trim())
    if (!Array.isArray(entries)) throw new Error(`container ${id} returned no environment array`)
    return Object.fromEntries(entries.map((entry) => {
        const separator = String(entry).indexOf('=')
        return separator < 1 ? null : [String(entry).slice(0, separator), String(entry).slice(separator + 1)]
    }).filter(Boolean))
}
// The password rides MYSQL_PWD through docker exec -e, never argv (utils/docker_mariadb.js).
async function databaseTool(stack, script, database, table, deps) {
    const id = stack.database.ID || dockerName(stack.database)
    return deps.execFileAsync('docker', dockerMariadbArgs(id, ['sh', '-c', script, 'sh', database, table]),
        { env: mariadbEnv(deps.mariadbPassword) })
}
const SHOW_TABLE = 'exec mariadb-show -u root "$1" "$2"'
const REBUILD_TABLE = 'f=$(mktemp) || exit 1; trap \'rm -f "$f"\' EXIT; '
    + 'mariadb-dump -u root --no-data "$1" "$2" >"$f" && mariadb -u root "$1" <"$f"'

async function tablePresent(stack, database, table, deps) {
    try {
        const result = await databaseTool(stack, SHOW_TABLE, database, table, deps)
        return commandOutput(result).split(/\s+/).includes(table)
    } catch (err) {
        // A refused login is not a missing table; reading it as one sent operators hunting a table that exists.
        const detail = String((err && (err.stderr || err.message)) || err)
        if (/Access denied/i.test(detail)) throw new Error('reset hub-checkpoints: the database refused the root login')
        return false
    }
}

function resetTables(withCapabilities) {
    const extra = withCapabilities ? [CAPABILITY_TABLE] : []
    return { hub: HUB_CHECKPOINT_TABLES.concat(extra), mirror: [MIRROR_CHECKPOINT_TABLE].concat(extra) }
}

// Every hub table must exist before anything stops, on the CLI's hub and each peer alike.
async function prepareHubDatabases(stack, tables, deps) {
    stack.hubDatabases = []
    for (const hub of [stack.hub].concat(stack.peers)) {
        const env = await containerEnvironment(hub, deps)
        const database = safeDatabaseName(env.HUB_DB_NAME, `${dockerName(hub)} HUB_DB_NAME`)
        for (const table of tables.hub) {
            if (!(await tablePresent(stack, database, table, deps))) {
                throw new Error(`reset hub-checkpoints: ${database}.${table} does not exist`)
            }
        }
        stack.hubDatabases.push(database)
    }
}

async function prepareCheckpointTargets(stacks, tables, deps) {
    for (const stack of stacks) {
        await prepareHubDatabases(stack, tables, deps)
        const candidates = new Set()
        for (const mirror of stack.mirrors.filter(item => dockerName(item).endsWith('-xchain-indexer'))) {
            const env = await containerEnvironment(mirror, deps)
            const database = safeDatabaseName(env.INDEXER_DB_NAME, `${dockerName(mirror)} INDEXER_DB_NAME`)
            candidates.add(database)
            candidates.add(database + '_HubMirror')
        }
        stack.mirrorTables = []
        for (const database of candidates) {
            for (const table of tables.mirror) {
                if (await tablePresent(stack, database, table, deps)) stack.mirrorTables.push({ database, table })
            }
        }
    }
}

function serviceFor(container, deps) {
    if (dockerName(container).endsWith('-xchain-indexer')) return deps.INDEXER_MODULE_NAME
    if (dockerName(container).endsWith('-xchain-explorer')) return 'xchain-explorer'
    return deps.HUB_MODULE_NAME
}

async function stopContainers(containers, stopped, deps) {
    for (const container of containers.filter(running)) {
        const id = container.ID || dockerName(container)
        await deps.stopModuleContainer(deps.stopContainer, serviceFor(container, deps), '', '', id,
            undefined, deps.getContainerStopSettings)
        stopped.push(container)
    }
}

async function startContainers(containers, failures, deps) {
    for (const container of containers) {
        try {
            await deps.startContainer(container.ID || dockerName(container))
        } catch (err) {
            failures.push(`${dockerName(container)} (${(err && err.message) || String(err)})`)
        }
    }
}

function stackHubs(stacks) {
    return stacks.flatMap(stack => [stack.hub].concat(stack.peers))
}

async function confirmHubCheckpointReset(stacks, tables, deps) {
    if (!process.stdin.isTTY) throw new Error('reset hub-checkpoints requires --yes on a non-interactive terminal')
    console.warn('\nWARNING: this will IRREVERSIBLY replace checkpoint lineage on every discovered rail hub.')
    console.warn(`  Rail hubs: ${stackHubs(stacks).map(dockerName).join(', ')}`)
    console.warn(`  Hub tables: ${tables.hub.join(', ')}`)
    console.warn(`  Mirror tables: ${tables.mirror.join(', ')}\n`)
    const prompt = deps.readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve => prompt.question('Type "yes" to confirm: ', resolve))
    prompt.close()
    return answer.trim().toLowerCase() === 'yes'
}

async function rebuildCheckpointTables(stacks, tables, deps) {
    for (const stack of stacks) {
        for (const database of stack.hubDatabases) {
            for (const table of tables.hub) await databaseTool(stack, REBUILD_TABLE, database, table, deps)
        }
    }
    for (const stack of stacks) {
        for (const { database, table } of stack.mirrorTables) {
            await databaseTool(stack, REBUILD_TABLE, database, table, deps)
        }
    }
}

async function resetHubCheckpoints(force, overrides = {}, options = {}) {
    const deps = { ...hubCheckpointDefaults, ...overrides }
    if (deps.EXTERNAL_DB) throw new Error('reset hub-checkpoints requires Docker-managed rail databases')
    const tables = resetTables(!!options.withCapabilities)
    deps.mariadbPassword = await deps.rootPassword()
    const listed = await deps.execFileAsync('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'])
    const stacks = railStacks(parseContainerList(listed), deps)
    await prepareCheckpointTargets(stacks, tables, deps)
    if (!force && !(await confirmHubCheckpointReset(stacks, tables, deps))) return false
    const hubs = [], mirrors = [], restartFailures = []
    try {
        await stopContainers(stackHubs(stacks), hubs, deps)
    } catch (err) {
        await startContainers(hubs, restartFailures, deps)
        console.log(`Aborted: a rail hub failed to stop (${(err && err.message) || String(err)}). No data was touched.`)
        return false
    }
    try {
        await stopContainers(stacks.flatMap(stack => stack.mirrors), mirrors, deps)
    } catch (err) {
        await startContainers(mirrors.concat(hubs), restartFailures, deps)
        console.log(`Aborted: a checkpoint mirror failed to stop (${(err && err.message) || String(err)}). No data was touched.`)
        return false
    }
    let failure = null
    try { await rebuildCheckpointTables(stacks, tables, deps) } catch (err) { failure = err }
    await startContainers(hubs.concat(mirrors), restartFailures, deps)
    await deps.statusChanged()
    if (failure) throw failure
    if (restartFailures.length) throw new Error('Services failed to restart: ' + restartFailures.join(', '))
    return true
}

module.exports = { resetHubCheckpoints }
