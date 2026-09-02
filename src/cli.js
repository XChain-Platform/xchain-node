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
const { redactSecrets } = require('./utils/helpers')
const {
    installModules,
    syncSharedServicesAfterInstall,
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
const { initValidator, getValidatorSettings, isInitialized, getCapabilityConfigHostPath,
        readWallets, publicWalletInfo, getSignerMountDir, COIN_NETWORKS, WALLETS_FILE,
        getRollcallStatus } = require('./services/ValidatorService')
const { stakeValidator, unstakeValidator } = require('./services/ValidatorStakeService')
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

// Which ref, if any, the command about to run will install its modules at.
//
// Only `install` and `update` take one; every other command yields null and
// leaves preCheck's hub provisioning exactly as it was. The classification is
// delegated to resolveArgs (the same call the actions make) so the two can never
// disagree about which positional is the ref, and it is wrapped because a refusal
// here must not abort the command before its own action can report the same
// problem with better context.
function refForPreCheck(commandName, actionCommand) {
    if (commandName !== 'install' && commandName !== 'update') return null
    try {
        return resolveArgs(actionCommand.args || [], { expectBranch: true, defaultBranch: null }).branch
    } catch {
        return null
    }
}

async function parseCommand() {
    installUnhandledRejectionHandler()
    installUncaughtExceptionHandler()
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
    // How long a MUTATING command blocks for a lock holder before refusing. Zero
    // keeps the interactive contract below; an unattended caller sets it so a
    // scheduled run waits out a deploy instead of losing its work.
    const MUTATING_LOCK_WAIT_MS = parseInt(process.env.XCHAIN_NODE_MUTATING_LOCK_WAIT_MS || '0', 10) || 0
    program.hook('preAction', async (thisCommand, actionCommand) => {
        setVerbose(thisCommand.opts().verbose ?? false)
        if (thisCommand.opts().verbose) console.log("Checking xchain-node structure")
        const commandName = actionCommand.name()
        // `validator` subcommands are offline (key generation + local config
        // file writes). They must NOT trigger the Docker/MariaDB precheck, so an
        // operator can prepare their validator identity before any stack is up.
        const parentName = actionCommand.parent && actionCommand.parent.name()
        if (commandName === 'validator' || parentName === 'validator') return
        // `rollback` is declared but unimplemented: its action only names the
        // reset-and-restore recovery path and exits non-zero. Provisioning
        // Docker/MariaDB/hub and taking the mutating lock to reach a two-line
        // refusal is what made it read as a hang. Measured 2026-08-30 while
        // repairing a regtest indexer: an operator reached for `rollback`
        // mid-incident and waited ~10 minutes on a command that printed nothing.
        // It stays listed in mutatingCommands above so that a real
        // implementation, which would drop this early return, is serialized.
        if (commandName === 'rollback') return

        // preCheck provisions shared containers/DB/hub (buildDatabaseModule,
        // ensureXchainNodeAccess, scanAndRegisterModules, installHubModule) for
        // EVERY non-validator command, not just the mutating ones. Running that
        // provisioning unlocked lets a concurrent `ps`/`e2etest`/`exec` tear down
        // and rebuild the hub out from under a lock-holding `update` mid docker
        // build. So acquire the lock around preCheck for every command.
        //
        // A mutating command keeps the lock through its whole action (released on
        // process exit, since actions terminate via process.exit()) and refuses
        // a held lock unless asked to wait. A non-mutating command holds
        // the lock only across preCheck, releasing it right after, so a
        // long-running `monitor`/`tail`/`logs` does not pin the lock for its
        // lifetime; it waits a bounded time for a busy mutator, then errors.
        const holdThroughAction = mutatingCommands.includes(commandName)
        let release
        try {
            release = acquireCommandLock({
                command: commandName,
                waitMs: holdThroughAction ? MUTATING_LOCK_WAIT_MS : LOCK_WAIT_MS
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
                !readOnlyCommands.includes(commandName),
                // The ref the action is about to install at, so the hub preCheck
                // provisions is staged from it too. Read with the SAME classifier
                // the action uses rather than "the first positional", because the
                // args are order-independent and only resolveArgs knows which one
                // is a ref (`install regtest` names a network, not a branch). A
                // command that names no ref, or an arg shape resolveArgs refuses,
                // yields null and the previous default-branch behaviour.
                refForPreCheck(commandName, actionCommand)
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
        // ONE ref slot, order-independent, classified by shape (release-management
        // spec section 11): a vX.Y.Z argument is a RELEASE and installs that
        // train's exact manifest-pinned component set; anything else is a branch
        // and installs a tracking (unreleased) checkout. Omitting it entirely
        // resolves the latest published xchain-node release, which is why this is
        // no longer a required argument.
        .argument('[ref]',     '(a release like v0.9.0, or a branch like master/develop; omit for the latest release)')
        .argument('[service]', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (branch, service, chain, network) => {
            // Honor the global `--no-bootstrap` flag (defined on the root program above):
            // commander assigns a flag matching a global option to the global, so reading
            // the install command's own opts would always see the default. Skips the
            // auto-download/restore and syncs from scratch.
            if (program.opts().bootstrap === false) process.env.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            // defaultBranch null: an absent ref must reach installModules as null
            // so it resolves the latest release. Substituting 'master' here would
            // make the documented default install a branch install forever.
            const resolved = resolveArgs([branch, service, chain, network], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            const installed = await installModules(serviceList, resolved.branch)
            // A coin installed by THIS run is unknown to the hub and explorer until
            // something tells them, and the thing that does runs in preCheck, ahead
            // of this action. Without it the command returns a stack whose explorer
            // serves 503 to everything.
            // Exit non-zero when the explorer never came up serving coins, so the
            // caller stops here rather than at its first read of a 503 stack.
            const usable = await syncSharedServicesAfterInstall(installed)
            return process.exit(usable ? 0 : 1)
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
            // A module that failed to uninstall used to be printed and forgotten,
            // leaving the command exiting 0 with containers still running. The
            // remaining modules are still attempted (uninstallModules finishes the
            // list first); only the exit status changes.
            try {
                await uninstallModules(serviceList, options.includeShared)
            } catch (err) {
                console.error('uninstall failed: ' + redactSecrets(err && err.message ? err.message : err))
                return process.exit(1)
            }
            return process.exit(0)
        })

    program
        .command('update')
        .description('Update XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .argument('[ref]',     '(a release like v0.9.0 for a pinned update, or any branch name; a branch is resolved on the module\'s remote, so push it first, or point the module at a local path with XCHAIN_NODE_MODULES_URLS_OVERRIDE. Omit to keep each module on its current branch)')
        .action(async (service, chain, network, branch) => {
            const resolved = resolveArgs([service, chain, network, branch], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            // Report a failed update as an error and exit non-zero instead of
            // letting it escape as an unhandled rejection. The deploy checkout
            // is left intact by cloneGit, so the message is the whole outcome:
            // nothing to roll back by hand.
            let outcome
            try {
                outcome = await updateModules(serviceList, resolved.branch)
            } catch (err) {
                console.error('update failed: ' + redactSecrets(err && err.message ? err.message : err))
                return process.exit(1)
            }
            // An update that touched nothing is a FAILED deploy, not a
            // successful one: the operator asked for new code to be running and
            // the old code still is. Exiting 0 here is what let scripts and
            // `&& echo ok` treat a no-op as a landed redeploy.
            if (outcome && Array.isArray(outcome.updated) && outcome.updated.length === 0) {
                const why = (outcome.skipped || [])
                    .map(s => `${s.module} (${s.coin} ${s.network}): ${s.reason}`)
                    .join('; ')
                console.error('update failed: nothing was updated' + (why ? ' - ' + why : ' (no requested service matched an installed container)'))
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
            let outcome
            try {
                outcome = await recreateModules(serviceList)
            } catch (err) {
                console.error('recreate failed: ' + redactSecrets(err && err.message ? err.message : err))
                return process.exit(1)
            }
            // Same rule as `update`: a run that recreated NO container did not do
            // what the operator asked, whatever it printed on the way. `recreate
            // node` (unsupported) took this path and still exited 0.
            if (!outcome || !Array.isArray(outcome.recreated) || outcome.recreated.length === 0) {
                const why = ((outcome && outcome.skipped) || [])
                    .map(s => `${s.module} (${s.coin} ${s.network}): ${s.reason}`)
                    .join('; ')
                console.error('recreate failed: nothing was recreated'
                    + (why ? ' - ' + why : ' (no requested service can be recreated from the config map)'))
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

    program
        .command('reset')
        .description('Reset data for a specific service or all services of a coin/network')
        .argument('<service>', '(node, xchain-utxo-tracker, xchain-decoder, xchain-indexer, all)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .option('--yes', 'Skip the destructive-reset confirmation prompt (for CI/scripted resets)')
        .option('--with-indexer', 'Reset xchain-indexer alongside xchain-decoder; the pair is only coherent when both move together')
        .action(async (service, chain, network, options) => {
            const confirmed = await resetModules(service, chain, network,
                !!(options && options.yes), !!(options && options.withIndexer))
            return process.exit(confirmed ? 0 : 1)
        })

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

    const validator = program
        .command('validator')
        .description('Validator-mode setup for the xchain-hub (key generation + config)')

    validator
        .command('init')
        .description('Generate a validator signing key + config so the hub runs in validator mode')
        .option('--seed-nodes <list>',        'comma-separated peer addresses (host:port,host:port)')
        .option('--p2p-addr <addr>',          'this validator\'s public address (host:port)')
        .option('--p2p-port <port>',          'P2P listen port (10002 testnet, 10001 mainnet; default 10001)')
        .option('--network <name>',           'federation to join: testnet or mainnet (default: implied by --p2p-port)')
        .option('--oracle-epoch-start <ms>',  'shared oracle epoch start (unix ms); defaults to the known federation value')
        .option('--capabilities <list>',      'enabled capabilities (default price,cross_chain,oracle_publish,attestation)')
        .option('--import-stake-key',         'use your own BTC stake key: prompts for the WIF (or set XCHAIN_NODE_STAKE_WIF)')
        .option('--import-doge-key',          'use your own DOGE publisher key: prompts for the WIF (or set XCHAIN_NODE_DOGE_WIF)')
        .option('--no-wallets',               'skip wallet generation (you run your own signer via XCHAIN_NODE_HUB_SIGNER_DIR)')
        .option('--mint-hub-api-key',         'on a re-run, generate a HUB_API_KEY if this host has none (401s every consumer that carries no key)')
        .option('--force',                    'overwrite existing validator config (generates a NEW signing key; wallets are kept)')
        .option('--force-wallets',            'also replace existing wallets (the old addresses and any coin at them are abandoned)')
        .action(async (opts) => {
            try {
                await initValidator(opts)
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(1)
            }
            return process.exit(0)
        })

    validator
        .command('stake')
        .description('Mint XCHAIN if short (testnet) and broadcast the STAKE naming this validator\'s pubkey; dry run without --broadcast')
        .option('--amount <xchain>',   'amount to stake (default 25000, clears every capability floor)')
        .option('--broadcast',         'actually send the transactions (default: print the plan only)')
        .option('--no-wait',           'return once the STAKE is broadcast instead of waiting for it to index')
        .option('--serialize',         'send one action per block (default: chained back to back into one block)')
        .option('--fee-per-kb <coin>', 'fee rate in coin per kB (default: the encoder\'s estimate)')
        .option('--timeout <minutes>', 'how long to wait for the stake to index (default 120)')
        .action(async (opts) => {
            try {
                await stakeValidator(opts)
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(1)
            }
            return process.exit(0)
        })

    validator
        .command('unstake')
        .description('Withdraw this validator\'s stake and leave the active set; dry run without --broadcast')
        .option('--broadcast',         'actually send the transaction (default: print the plan only)')
        .option('--no-wait',           'return once broadcast instead of waiting for it to index')
        .option('--fee-per-kb <coin>', 'fee rate in coin per kB (default: the encoder\'s estimate)')
        .option('--timeout <minutes>', 'how long to wait for it to index (default 120)')
        .action(async (opts) => {
            try {
                await unstakeValidator(opts)
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(1)
            }
            return process.exit(0)
        })

    validator
        .command('status')
        .description('Show this node\'s validator configuration (pubkey, wallets, peers, capabilities)')
        .action(async () => {
            const s = getValidatorSettings()
            if (!s) {
                console.log(isInitialized()
                    ? 'Validator is initialized but disabled.'
                    : 'No validator configured. Run: xchain-node validator init')
            } else {
                console.log('Validator enabled.')
                console.log('  pubkey       : ' + s.pubkey)
                console.log('  network      : ' + (s.network || '(unset; set HUB_NETWORK in .env)'))
                console.log('  p2p address  : ' + s.P2P_VALIDATOR_ADDR)
                console.log('  seed nodes   : ' + ((s.SEED_NODES || []).join(', ') || '(none)'))
                console.log('  oracle epoch : ' + (s.ORACLE_EPOCH_START || '(unset, required before oracle runs)'))
                console.log('  capabilities : ' + ((s.capabilities || []).join(', ') || '(none)'))
                // Print the live path: it moved into its own directory (so the hub's
                // bind mount cannot break `docker cp`), and this is where an operator
                // coming from an older install finds it after the migration.
                console.log('  caps config  : ' + (getCapabilityConfigHostPath() || '(missing; re-run validator init)'))
                // Addresses only. The keys stay in the 0600 file.
                const w = publicWalletInfo(readWallets())
                const coins = COIN_NETWORKS[(w && w.network) || s.network] || { stakeCoin: 'coin', dogeCoin: 'DOGE' }
                if (w) {
                    console.log('  stake wallet : ' + w.stakeAddress + '  (' + coins.stakeCoin + ' for fees, holds the XCHAIN stake)')
                    console.log('  DOGE wallet  : ' + w.dogeAddress + '  (' + coins.dogeCoin + ' for price rounds and anchors)')
                    console.log('  keys file    : ' + WALLETS_FILE + ' (mode 0600; back it up)')
                    console.log('  DOGE signer  : ' + (process.env.XCHAIN_NODE_HUB_SIGNER_DIR
                        ? process.env.XCHAIN_NODE_HUB_SIGNER_DIR + ' (operator-supplied, XCHAIN_NODE_HUB_SIGNER_DIR)'
                        : (getSignerMountDir() || '(missing; re-run validator init)')))
                } else {
                    console.log('  wallets      : (none; re-run validator init, or run your own signer via XCHAIN_NODE_HUB_SIGNER_DIR)')
                }
                // ROLLCALL reporting: the DOGE runway (reusing the address read above,
                // never a second fetch), whether the configured signer can PUBLISH a
                // roll call rather than only sign one, and this key's BTC-side absence
                // streak. Each degrades to its own "unavailable" line instead of
                // crashing the whole command or printing a reassuring zero.
                const rollcall = await getRollcallStatus(w, (w && w.network) || s.network)
                if (rollcall.doge) {
                    console.log(rollcall.doge.unavailable
                        ? '  DOGE runway  : unavailable (could not read the DOGE wallet balance' +
                          (rollcall.doge.error ? ': ' + rollcall.doge.error : '') + ')'
                        : '  DOGE runway  : ' + rollcall.doge.balance + ' ' + coins.dogeCoin + ' confirmed, ~' +
                          rollcall.doge.rollcalls + ' roll call(s) of runway (~0.006 ' + coins.dogeCoin +
                          ' each: two ~0.003 ' + coins.dogeCoin + ' transactions)')
                }
                if (rollcall.broadcast) {
                    console.log(rollcall.broadcast.exportsBroadcast
                        ? '  roll call    : this signer exports broadcast, so it can publish roll calls'
                        : '  roll call    : NO broadcast export in ' + rollcall.broadcast.file +
                          ' - it can SIGN a roll call but never PUBLISH one, silently. Add broadcast(payload) ' +
                          'or use the CLI-generated signer.')
                }
                if (rollcall.absences) {
                    if (rollcall.absences.unavailable) {
                        console.log('  roll call absences (BTC): unavailable (' +
                            (rollcall.absences.error || rollcall.absences.reason || 'indexer read failed') +
                            '); check the explorer before assuming this key is safe')
                    } else if (rollcall.absences.streak === 0) {
                        console.log('  roll call absences (BTC): none on record')
                    } else if (rollcall.absences.streak === 1) {
                        console.log('  roll call absences (BTC): 1 (warning shot; one more consecutive miss evicts this stake)')
                    } else {
                        console.log('  roll call absences (BTC): ' + rollcall.absences.streak +
                            (rollcall.absences.evictedNow ? '  EVICTED - dropped from every capability set' : ''))
                    }
                }
                console.log('')
                console.log('  On-chain membership: xchain-node validator stake   (dry run shows balances and the stake)')
            }
            return process.exit(0)
        })

    program.parse(process.argv)
}

// installUnhandledRejectionHandler and installUncaughtExceptionHandler are
// exported for their unit tests only; the CLI installs both itself at the top
// of parseCommand().
// refForPreCheck is exported for its unit test: it decides which tree the hub is
// built from, and the defect it fixes was invisible in every log until a deploy
// line named the wrong branch.
module.exports = { parseCommand, installUnhandledRejectionHandler, installUncaughtExceptionHandler, refForPreCheck }

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
