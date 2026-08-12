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

const { Command }  = require('commander')
const { version }  = require('../package.json')
const { preCheck } = require('./precheck')
const { setVerbose } = require('./state')
const { filterCommandParameters, resolveArgs } = require('./services/ConfigService')
const {
    installModules,
    updateModules,
    recreateModules,
    uninstallModules,
    logModules,
    monitorModules,
    restartModules,
    stopModules,
    startModules,
    execModules,
    shellModule,
    runE2ETest,
    resetModules
} = require('./operations/moduleOperations')
const { getStatus }            = require('./services/StatusService')
const { scanAndRegisterModules } = require('./services/DiscoveryService')
const { maybeReportTelemetry } = require('./services/TelemetryService')
const { makeBootstrap, listServedBootstrapCombos } = require('./services/BootstrapService')
const { initValidator, getValidatorSettings, isInitialized } = require('./services/ValidatorService')
const { restoreBootstrapInterface, startInterface } = require('./ui/menu')
const { acquireCommandLock } = require('./utils/commandLock')

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

async function parseCommand() {
    installUnhandledRejectionHandler()
    const program = new Command()

    const commandsNeedingVersions = ['install', 'update', 'reinstall']
    // Read-only commands only display state and never change which services
    // are installed/running, so they don't need to push local config to the
    // hub/explorer. Skipping the push keeps them fast and avoids the lengthy
    // updateconfig round-trip on multi-coin nodes. Any command NOT listed here
    // (install, update, start, stop, restart, uninstall, reset, sync, …) still
    // pushes; the default is to sync, so a new/unknown command stays safe.
    const readOnlyCommands = ['ps', 'tail', 'logs', 'monitor', 'tailmonitor', 'bootstrap-combos']
    // Commands that mutate stack state (containers, images, DBs, config
    // pushes). Two of these interleaving from concurrent shells can corrupt an
    // install mid-flight, so they serialize on a pidfile lock; a second
    // invocation is refused with a clear message instead of interleaving.
    // `e2etest` is included: its action does its own docker build/run/rm, so it
    // must stay serialized against install/update the same way the others are.
    const mutatingCommands = ['install', 'update', 'recreate', 'reinstall', 'uninstall', 'reset', 'bootstrap', 'sync', 'start', 'stop', 'restart', 'rollback', 'autoheal', 'e2etest']
    // How long a non-mutating command blocks for a lock-holding mutator before
    // giving up (bounded so a read-only command pauses, then errors clearly,
    // rather than corrupting the stack by provisioning concurrently). Tunable.
    const LOCK_WAIT_MS = parseInt(process.env.XCHAIN_NODE_LOCK_WAIT_MS || '15000', 10) || 15000
    program.hook('preAction', async (thisCommand, actionCommand) => {
        setVerbose(thisCommand.opts().verbose ?? false)
        if (thisCommand.opts().verbose) console.log("Checking xchain-node structure")
        const commandName = actionCommand.name()
        // `validator` subcommands are offline (key generation + local config
        // file writes). They must NOT trigger the Docker/MariaDB precheck, so an
        // operator can prepare their validator identity before any stack is up.
        const parentName = actionCommand.parent && actionCommand.parent.name()
        if (commandName === 'validator' || parentName === 'validator') return

        // preCheck provisions shared containers/DB/hub (buildDatabaseModule,
        // ensureXchainNodeAccess, scanAndRegisterModules, installHubModule) for
        // EVERY non-validator command, not just the mutating ones. Running that
        // provisioning unlocked lets a concurrent `ps`/`e2etest`/`exec` tear down
        // and rebuild the hub out from under a lock-holding `update` mid docker
        // build. So acquire the lock around preCheck for every command.
        //
        // A mutating command keeps the lock through its whole action (released on
        // process exit, since actions terminate via process.exit()) and refuses
        // immediately if another instance holds it. A non-mutating command holds
        // the lock only across preCheck, releasing it right after, so a
        // long-running `monitor`/`tail`/`logs` does not pin the lock for its
        // lifetime; it waits a bounded time for a busy mutator, then errors.
        const holdThroughAction = mutatingCommands.includes(commandName)
        let release
        try {
            release = acquireCommandLock({
                command: commandName,
                waitMs: holdThroughAction ? 0 : LOCK_WAIT_MS
            })
        } catch (err) {
            console.error(err.message)
            return process.exit(1)
        }
        if (holdThroughAction) {
            // Release only on process exit (also covers throws and SIGINT/SIGTERM
            // via the default handlers ending the process).
            process.on('exit', release)
            process.on('SIGINT', () => process.exit(130))
            process.on('SIGTERM', () => process.exit(143))
        }
        try {
            await preCheck(
                commandsNeedingVersions.includes(commandName),
                !readOnlyCommands.includes(commandName)
            )
        } finally {
            // Non-mutating commands hand the lock back as soon as provisioning is
            // done; mutating commands keep it (released on exit) for their action.
            if (!holdThroughAction) release()
        }
        // Anonymous usage telemetry (default-on, opt-out). Fire-and-forget:
        // a failure here must never block or break the command being run.
        try {
            const optOut = thisCommand.opts().telemetry === false
            await maybeReportTelemetry(actionCommand.name(), optOut)
        } catch { /* telemetry is best-effort */ }
    })

    program
        .name('xchain-node')
        .version(version, '-V, --version', 'Shows xchain-node version')
        .option('-v, --verbose', 'Print precheck progress messages')
        .option('-i, --interactive', 'Interactive mode')
        .option('--no-bootstrap', 'Do not download bootstrap files (full parse)')
        .option('--no-explorer', 'Do not install xchain-explorer')
        .option('--no-telemetry', 'Disable anonymous usage telemetry (see Privacy & Telemetry docs)')
        .action(async (options) => {
            if (options.interactive) {
                return startInterface()
            }
            program.help()
        })

    program
        .command('install')
        .description('Installs XChain services')
        .argument('<branch>',  '(master, develop)')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (branch, service, chain, network) => {
            // Honor the global `--no-bootstrap` flag (defined on the root program above):
            // commander assigns a flag matching a global option to the global, so reading
            // the install command's own opts would always see the default. Skips the
            // auto-download/restore and syncs from scratch.
            if (program.opts().bootstrap === false) process.env.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            const resolved = resolveArgs([branch, service, chain, network], { expectBranch: true })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            await installModules(serviceList, resolved.branch)
            return process.exit(0)
        })

    program
        .command('uninstall')
        .description('Uninstall XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .option('--include-shared', 'Also uninstall shared services (database, xchain-hub, xchain-explorer, xchain-sync)')
        .action(async (service, chain, network, options) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await uninstallModules(serviceList, options.includeShared)
            return process.exit(0)
        })

    program
        .command('update')
        .description('Update XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .argument('[branch]',  '(master, develop, or any branch name; resolved on the module\'s remote, so push it first, or point the module at a local path with XCHAIN_NODE_MODULES_URLS_OVERRIDE)')
        .action(async (service, chain, network, branch) => {
            const resolved = resolveArgs([service, chain, network, branch], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            // Report a failed update as an error and exit non-zero instead of
            // letting it escape as an unhandled rejection. The deploy checkout
            // is left intact by cloneGit, so the message is the whole outcome:
            // nothing to roll back by hand.
            try {
                await updateModules(serviceList, resolved.branch)
            } catch (err) {
                console.error('update failed: ' + (err && err.message ? err.message : err))
                return process.exit(1)
            }
            return process.exit(0)
        })

    program
        .command('recreate')
        .description('Recreate a service container from the current config, reusing its existing image (no rebuild, no re-clone)')
        .argument('<service>', '(xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            try {
                await recreateModules(serviceList)
            } catch (err) {
                console.error('recreate failed: ' + (err && err.message ? err.message : err))
                return process.exit(1)
            }
            // The operator's next move is always to check the container came back,
            // so print the status here instead of making them ask for it.
            await getStatus(null, null, true)
            return process.exit(0)
        })

    program
        .command('ps')
        .description('List installed XChain services and status')
        .action(async () => {
            await getStatus(null, null, true)
            return process.exit(0)
        })

    program
        .command('bootstrap-combos')
        .description('List served <service>:<coin>:<network> combos, one per line (scriptable)')
        .addHelpText('after', `
Reads the module registry, not live containers, so a STOPPED or crash-looping
combo is still listed. scripts/publish-bootstraps.sh --all builds its plan from
this: detecting from \`docker ps\` dropped stopped combos before the source-health
gate could report them, so the cron exited 0 while a consumer archive went stale.`)
        .action(async () => {
            const combos = await listServedBootstrapCombos()
            for (const combo of combos) console.log(combo)
            return process.exit(0)
        })

    program
        .command('sync')
        .description('Scan Docker for xchain-node containers and register any missing in the database')
        .action(async () => {
            const added = await scanAndRegisterModules()
            console.log(added === 0 ? "Nothing to add (already in sync)" : `Registered ${added} module(s)`)
            return process.exit(0)
        })

    program
        .command('start')
        .description('Start XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await startModules(serviceList)
            return process.exit(0)
        })

    program
        .command('stop')
        .description('Stop XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await stopModules(serviceList)
            return process.exit(0)
        })

    program
        .command('restart')
        .description('Restart XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await restartModules(serviceList)
            return process.exit(0)
        })

    program
        .command('autoheal')
        .description('Restart containers stuck in the Docker "unhealthy" state (opt-in per service); one-shot, cron/timer safe')
        .option('--dry-run', 'report restart candidates without acting')
        .action(async (options) => {
            const { runAutoheal } = require('./services/AutohealService')
            const result = await runAutoheal({ dryRun: options.dryRun ?? false })
            // Exit non-zero ONLY when a restart was attempted and failed, so a
            // timer unit can alert on real remediation failures without paging
            // on "nothing to do" passes.
            return process.exit(result.failed.length > 0 ? 1 : 0)
        })

    program
        .command('tail')
        .description('Tail XChain service logs')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await logModules(serviceList)
            return process.exit(0)
        })

    program
        .command('logs')
        .description('Display full XChain service logs')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await logModules(serviceList, false)
            return process.exit(0)
        })

    program
        .command('monitor')
        .description('Display service logs in split spaces on the screen')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await monitorModules(serviceList, false)
            return process.exit(0)
        })

    program
        .command('tailmonitor')
        .description('Display service logs in split spaces on the screen (follow)')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await monitorModules(serviceList)
            return process.exit(0)
        })

    program
        .command('exec')
        .description('Execute command on XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .argument('<command>', 'The shell command to execute')
        .action(async (service, chain, network, command) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await execModules(serviceList, command)
            return process.exit(0)
        })

    program
        .command('shell')
        .description('Shell into a XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .action(async (service, chain, network) => {
            if (service === "all" || chain === "all" || network === "all") {
                console.log("The shell command can't be used for multiple containers, 'all' is invalid")
                return process.exit(0)
            }
            const serviceList = filterCommandParameters(null, service, chain, network)
            await shellModule(serviceList)
            return process.exit(0)
        })

    program
        .command('e2etest')
        .description('Run E2E tests on a regtest network')
        .argument('<chain>', '(bitcoin, litecoin, dogecoin)')
        .argument('[testName]', 'optional test file name (e.g. "order", "issue"); runs only that suite')
        .option('--grep <pattern>', 'only run tests matching this pattern (passed to mocha --grep)')
        .option('--script <npmScript>', 'run a specific e2e npm script (e.g. test:security) instead of the default suite')
        .action(async (chain, testName, options) => {
            const { logFile, exitCode } = await runE2ETest(chain, 'regtest', testName, options.grep, options.script)
            console.log("E2E tests finished with exit code " + exitCode)
            console.log("Logs saved to: " + logFile)
            // Propagate the suite's real exit code so CI (and run-multichain-e2e.sh)
            // can gate on $? natively instead of scraping the line above.
            return process.exit(exitCode)
        })

    program
        .command('reset')
        .description('Reset data for a specific service or all services of a coin/network')
        .argument('<service>', '(node, xchain-utxo-tracker, xchain-decoder, xchain-indexer, all)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .option('--yes', 'Skip the destructive-reset confirmation prompt (for CI/scripted resets)')
        .action(async (service, chain, network, options) => {
            const confirmed = await resetModules(service, chain, network, !!(options && options.yes))
            return process.exit(confirmed ? 0 : 1)
        })

    program
        .command('rollback')
        .description('Rollback XChain service to a set block_index')
        .argument('<block_index>', 'The index of the last known good block')
        .argument('<service>',     '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, all)')
        .argument('<chain>',       '(bitcoin, litecoin, dogecoin)')
        .argument('<network>',     '(mainnet, testnet, regtest)')
        .action(async () => {
            // Not yet implemented. Fail loudly instead of silently doing nothing,
            // so operators don't believe a rollback occurred.
            console.error('`rollback` is not yet implemented. To recover a service to a known-good block, use `reset` followed by a bootstrap restore.')
            process.exitCode = 1
        })

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
                        console.error(err.message)
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
                        console.error(err.message)
                        return process.exit(1)
                    }
                    throw err
                }
            }
            return process.exit(0)
        })

    const validator = program
        .command('validator')
        .description('Validator-mode setup for the xchain-hub (key generation + config)')

    validator
        .command('init')
        .description('Generate a validator signing key + config so the hub runs in validator mode')
        .option('--seed-nodes <list>',        'comma-separated peer addresses (host:port,host:port)')
        .option('--p2p-addr <addr>',          'this validator\'s public address (host:port)')
        .option('--p2p-port <port>',          'P2P listen port (default 10001)')
        .option('--oracle-epoch-start <ms>',  'shared oracle epoch start (unix ms); must match the federation')
        .option('--capabilities <list>',      'enabled capabilities (default price,cross_chain,oracle_publish,attestation)')
        .option('--force',                    'overwrite existing validator config (generates a NEW key)')
        .action(async (opts) => {
            await initValidator(opts)
            return process.exit(0)
        })

    validator
        .command('status')
        .description('Show this node\'s validator configuration (pubkey, peers, capabilities)')
        .action(async () => {
            const s = getValidatorSettings()
            if (!s) {
                console.log(isInitialized()
                    ? 'Validator is initialized but disabled.'
                    : 'No validator configured. Run: xchain-node validator init')
            } else {
                console.log('Validator enabled.')
                console.log('  pubkey       : ' + s.pubkey)
                console.log('  p2p address  : ' + s.P2P_VALIDATOR_ADDR)
                console.log('  seed nodes   : ' + ((s.SEED_NODES || []).join(', ') || '(none)'))
                console.log('  oracle epoch : ' + (s.ORACLE_EPOCH_START || '(unset, required before oracle runs)'))
                console.log('  capabilities : ' + ((s.capabilities || []).join(', ') || '(none)'))
            }
            return process.exit(0)
        })

    program.parse(process.argv)
}

// installUnhandledRejectionHandler is exported for its unit test only; the CLI
// installs it itself at the top of parseCommand().
module.exports = { parseCommand, installUnhandledRejectionHandler }

// Allow running this file directly (`node src/cli.js <cmd>`) as well as via the
// bin entrypoint `src/index.js`. When cli.js is required as a module (index.js
// does `require('./cli')`), require.main is the entrypoint, not this file, so
// parseCommand is NOT auto-invoked here and index.js remains the single caller.
// Running it directly otherwise silently does nothing, because program.parse()
// lives inside parseCommand() and would never be called.
if (require.main === module) {
    require('dotenv').config()
    parseCommand()
}
