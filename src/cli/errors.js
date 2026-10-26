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
 * Commander setup and command definitions
 ********************************************************************/
const { execFile } = require('child_process')
const { promisify } = require('util')
const readline = require('readline')
const config = require('../config')
const dockerService = require('../services/docker_service')
const { stopModuleContainer } = require('../services/stop_budget_service')
const { statusChanged } = require('../services/status_service')
const { registerReset } = require('./reset_command')

const HUB_CHECKPOINT_TABLES = Object.freeze([
    'state_checkpoints', 'snapshot_checkpoints', 'anchor_published_checkpoints'
])
const MIRROR_CHECKPOINT_TABLE = 'state_checkpoints'
const execFileAsync = promisify(execFile)
const hubCheckpointDefaults = {
    execFileAsync,
    readline,
    stopContainer: dockerService.stopContainer,
    startContainer: dockerService.startContainer,
    getContainerStopSettings: dockerService.getContainerStopSettings,
    stopModuleContainer,
    statusChanged,
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
function parseContainerList(result) {
    return commandOutput(result).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
}
function railStacks(containers, deps) {
    const suffix = '-' + deps.HUB_MODULE_NAME
    const stacks = containers.filter(container => dockerName(container).endsWith(suffix)).map((hub) => {
        const prefix = dockerName(hub).slice(0, -suffix.length)
        const database = containers.find(container => dockerName(container) === prefix + '-database')
        if (!database) throw new Error(`reset hub-checkpoints: no database container found for ${dockerName(hub)}`)
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const indexer = new RegExp('^' + escaped
            + '-(?:bitcoin|litecoin|dogecoin)-(?:mainnet|testnet|regtest)-xchain-indexer$')
        const mirrors = containers.filter(container => indexer.test(dockerName(container))
            || dockerName(container) === prefix + '-xchain-explorer')
        return { hub, database, mirrors }
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
async function databaseTool(stack, script, database, table, deps) {
    const id = stack.database.ID || dockerName(stack.database)
    return deps.execFileAsync('docker', ['exec', id, 'sh', '-c', script, 'sh', database, table])
}
const SHOW_TABLE = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb-show -u root "$1" "$2"'
const REBUILD_TABLE = 'f=$(mktemp) || exit 1; trap \'rm -f "$f"\' EXIT; '
    + 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD; '
    + 'mariadb-dump -u root --no-data "$1" "$2" >"$f" && mariadb -u root "$1" <"$f"'

async function tablePresent(stack, database, table, deps) {
    try {
        const result = await databaseTool(stack, SHOW_TABLE, database, table, deps)
        return commandOutput(result).split(/\s+/).includes(table)
    } catch {
        return false
    }
}

async function prepareCheckpointTargets(stacks, deps) {
    for (const stack of stacks) {
        const hubEnv = await containerEnvironment(stack.hub, deps)
        stack.hubDatabase = safeDatabaseName(hubEnv.HUB_DB_NAME, `${dockerName(stack.hub)} HUB_DB_NAME`)
        for (const table of HUB_CHECKPOINT_TABLES) {
            if (!(await tablePresent(stack, stack.hubDatabase, table, deps))) {
                throw new Error(`reset hub-checkpoints: ${stack.hubDatabase}.${table} does not exist`)
            }
        }
        const candidates = new Set()
        for (const mirror of stack.mirrors.filter(item => dockerName(item).endsWith('-xchain-indexer'))) {
            const env = await containerEnvironment(mirror, deps)
            const database = safeDatabaseName(env.INDEXER_DB_NAME, `${dockerName(mirror)} INDEXER_DB_NAME`)
            candidates.add(database)
            candidates.add(database + '_HubMirror')
        }
        stack.mirrorDatabases = []
        for (const database of candidates) {
            if (await tablePresent(stack, database, MIRROR_CHECKPOINT_TABLE, deps)) stack.mirrorDatabases.push(database)
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

async function confirmHubCheckpointReset(stacks, deps) {
    if (!process.stdin.isTTY) throw new Error('reset hub-checkpoints requires --yes on a non-interactive terminal')
    console.warn('\nWARNING: this will IRREVERSIBLY replace checkpoint lineage on every discovered rail hub.')
    console.warn(`  Rail hubs: ${stacks.map(stack => dockerName(stack.hub)).join(', ')}`)
    console.warn(`  Hub tables: ${HUB_CHECKPOINT_TABLES.join(', ')}`)
    console.warn(`  Mirror table: ${MIRROR_CHECKPOINT_TABLE}\n`)
    const prompt = deps.readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve => prompt.question('Type "yes" to confirm: ', resolve))
    prompt.close()
    return answer.trim().toLowerCase() === 'yes'
}

async function rebuildCheckpointTables(stacks, deps) {
    for (const stack of stacks) {
        for (const table of HUB_CHECKPOINT_TABLES) {
            await databaseTool(stack, REBUILD_TABLE, stack.hubDatabase, table, deps)
        }
    }
    for (const stack of stacks) {
        for (const database of stack.mirrorDatabases) {
            await databaseTool(stack, REBUILD_TABLE, database, MIRROR_CHECKPOINT_TABLE, deps)
        }
    }
}

async function resetHubCheckpoints(force, overrides = {}) {
    const deps = { ...hubCheckpointDefaults, ...overrides }
    if (deps.EXTERNAL_DB) throw new Error('reset hub-checkpoints requires Docker-managed rail databases')
    const listed = await deps.execFileAsync('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'])
    const stacks = railStacks(parseContainerList(listed), deps)
    await prepareCheckpointTargets(stacks, deps)
    if (!force && !(await confirmHubCheckpointReset(stacks, deps))) return false
    const hubs = [], mirrors = [], restartFailures = []
    try {
        await stopContainers(stacks.map(stack => stack.hub), hubs, deps)
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
    try { await rebuildCheckpointTables(stacks, deps) } catch (err) { failure = err }
    await startContainers(hubs.concat(mirrors), restartFailures, deps)
    await deps.statusChanged()
    if (failure) throw failure
    if (restartFailures.length) throw new Error('Services failed to restart: ' + restartFailures.join(', '))
    return true
}
// Commander's action handlers are async, but program.parse() is synchronous:
// anything an action rejects with escapes as an unhandled rejection, which Node
// prints as an ERR_UNHANDLED_REJECTION stack. Several services reject with a
// plain string (cloneGit, buildAndUp), and a string reason turns that stack into
// noise with the actual message buried in it. Register one backstop
// that prints the reason readably and exits non-zero, keeping the stack when the
// reason is a real Error so genuine bugs stay debuggable.
function installUnhandledRejectionHandler() {
    process.on('unhandledRejection', (reason) => {
        const detail = reason instanceof Error
            ? (reason.stack || reason.message)
            : String(reason)
        console.error('xchain-node: command failed: ' + detail)
        process.exit(1)
    })
}

// Same backstop as above, for a synchronous throw that escapes an action
// handler instead of a rejection. Without this, node prints its own uncaught
// exception dump and the process state past that point is unknown, so this
// still exits non-zero rather than letting the CLI continue.
function installUncaughtExceptionHandler() {
    process.on('uncaughtException', (err) => {
        const detail = err instanceof Error
            ? (err.stack || err.message)
            : String(err)
        console.error('xchain-node: command failed: ' + detail)
        process.exit(1)
    })
}


function registerE2eTest(program, deps) {
    const { runE2ETest } = deps
    program
        .command('e2etest')
        .description('Run E2E tests on a regtest network')
        .argument('<chain>', '(bitcoin, litecoin, dogecoin)')
        .argument('[testName]', 'optional test file name (e.g. "order", "issue"); runs only that suite')
        .option('--grep <pattern>', 'only run tests matching this pattern (passed to mocha --grep)')
        .option('--script <npmScript>', 'run a specific e2e npm script (e.g. test:security) instead of the default suite')
        // The suite is CODE, cloned like any other module, and it defaulted to
        // xchain-e2e-test's default branch no matter which ref the stack under it
        // was installed at. For the release ceremony's freeze gate that means
        // master's suites grading a release stack: a suite added or corrected on
        // the release branch never runs, and one deleted there runs anyway.
        // Omitted, the previous default-branch behaviour is unchanged.
        .option('--ref <ref>', 'clone the e2e-test suite at this ref (match the ref the stack was installed at)')
        .action(async (chain, testName, options) => {
            const { logFile, exitCode } = await runE2ETest(chain, 'regtest', testName, options.grep, options.script, options.ref || null)
            console.log("E2E tests finished with exit code " + exitCode)
            console.log("Logs saved to: " + logFile)
            // Propagate the suite's real exit code so CI (and run-multichain-e2e.sh)
            // can gate on $? natively instead of scraping the line above.
            return process.exit(exitCode)
        })

}

function registerRollback(program) {
    program
        .command('rollback')
        .description('NOT IMPLEMENTED - prints the reset + bootstrap restore path for recovering a service to a block_index')
        .argument('<block_index>', 'The index of the last known good block')
        .argument('<service>',     '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, all)')
        .argument('<chain>',       '(bitcoin, litecoin, dogecoin)')
        .argument('<network>',     '(mainnet, testnet, regtest)')
        .action(async (blockIndex, service, chain, network) => {
            // Not yet implemented. Fail loudly instead of silently doing nothing,
            // so operators don't believe a rollback occurred. This is reached
            // during an incident, so it prints the runnable recovery path with
            // the operator's own arguments already substituted in, and exits
            // through process.exit(): setting process.exitCode alone left the
            // process alive on whatever handles were open, which is how a
            // command that had already printed its answer still looked hung.
            console.error('`rollback` is not yet implemented; nothing was rolled back.')
            console.error(`To recover ${service} (${chain} ${network}) to block ${blockIndex}, use reset followed by a bootstrap restore:`)
            console.error(`    xchain-node reset ${service} ${chain} ${network}`)
            console.error(`    xchain-node bootstrap restore ${service} ${chain} ${network}`)
            console.error('Restore rewinds to the newest bootstrap at or before that block, then the service re-parses forward.')
            return process.exit(1)
        })

}

function registerBootstrap(program, deps) {
    const { makeBootstrap, restoreBootstrapInterface, redactSecrets } = deps
    program
        .command('bootstrap')
        .description('Create / Restore XChain service bootstraps')
        .argument('<action>',  '(create, restore)')
        .argument('<service>', '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-hub)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .option('--latest',       'restore the newest bootstrap without prompting (scriptable)')
        .option('--file <name>',  'restore this exact bootstrap archive without prompting')
        .addHelpText('after', `
Notes:
    bootstrap create  - generates a bootstrap file
    bootstrap restore - restores a bootstrap file

    restore prompts only on a TTY. With --latest, --file, or no TTY it
    resolves non-interactively, so a script cannot wedge on an unanswerable
    menu while holding the command lock.`)
        .action(async (action, service, chain, network, options) => {
            if (action === "create") {
                try {
                    await makeBootstrap(chain, network, service)
                } catch (err) {
                    // A source-health refusal is an expected, actionable outcome,
                    // not a crash: print the reasons and exit non-zero so the
                    // cron publisher can classify it, with no stack trace to
                    // read past. Anything else keeps its stack.
                    if (err && err.name === 'BootstrapSourceUnhealthyError') {
                        console.error(redactSecrets(err.message))
                        return process.exit(1)
                    }
                    throw err
                }
            } else {
                try {
                    await restoreBootstrapInterface(chain, network, service, {
                        latest: options.latest === true,
                        file:   options.file || null,
                    })
                } catch (err) {
                    // Mirror the create path above: an integrity/provenance
                    // refusal (bad signature, unsigned archive, inner-checksum
                    // mismatch) is the supply-chain gate doing its job, so print
                    // the reason and exit non-zero. Leaving it uncaught printed a
                    // stack trace that reads as a tool crash and invites a retry
                    // of a restore that must never succeed.
                    if (err && err.name === 'BootstrapIntegrityError') {
                        console.error(redactSecrets(err.message))
                        return process.exit(1)
                    }
                    throw err
                }
            }
            return process.exit(0)
        })

}

function registerPreRecoveryCommands(program, deps) {
    registerE2eTest(program, deps)
    registerReset(program, deps, resetHubCheckpoints)
}

function registerRecoveryCommands(program, deps) {
    registerRollback(program)
    registerBootstrap(program, deps)
}

module.exports = {
    installUnhandledRejectionHandler,
    installUncaughtExceptionHandler,
    registerPreRecoveryCommands,
    registerRecoveryCommands,
    resetHubCheckpoints
}
