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
function configureRootOptions(program, deps) {
    const { version, startInterface } = deps
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

}

function registerSync(program, deps) {
    const { scanAndRegisterModules } = deps
    program
        .command('sync')
        .description('Scan Docker for xchain-node containers and register any missing in the database')
        .action(async () => {
            const added = await scanAndRegisterModules()
            console.log(added === 0 ? "Nothing to add (already in sync)" : `Registered ${added} module(s)`)
            return process.exit(0)
        })

}

function registerStart(program, deps) {
    const { filterCommandParameters, startModules } = deps
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

}

function registerStop(program, deps) {
    const { filterCommandParameters, stopModules } = deps
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

}

function registerRestart(program, deps) {
    const { filterCommandParameters, restartModules } = deps
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

}

function registerAutoheal(program, deps) {
    const { loadModule } = deps
    program
        .command('autoheal')
        .description('Restart containers stuck in the Docker "unhealthy" state (opt-in per service); one-shot, cron/timer safe')
        .option('--dry-run', 'report restart candidates without acting')
        .action(async (options) => {
            const { runAutoheal } = loadModule('./services/autoheal_service')
            const result = await runAutoheal({ dryRun: options.dryRun ?? false })
            // Exit non-zero ONLY when a restart was attempted and failed, so a
            // timer unit can alert on real remediation failures without paging
            // on "nothing to do" passes.
            return process.exit(result.failed.length > 0 ? 1 : 0)
        })

}

function registerTail(program, deps) {
    const { filterCommandParameters, logModules } = deps
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

}

function registerLogs(program, deps) {
    const { filterCommandParameters, logModules } = deps
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

}

function registerMonitor(program, deps) {
    const { filterCommandParameters, monitorModules } = deps
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

}

function registerTailMonitor(program, deps) {
    const { filterCommandParameters, monitorModules } = deps
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

}

function registerLifecycleCommands(program, deps) {
    registerSync(program, deps)
    registerStart(program, deps)
    registerStop(program, deps)
    registerRestart(program, deps)
    registerAutoheal(program, deps)
}

function registerStreamCommands(program, deps) {
    registerTail(program, deps)
    registerLogs(program, deps)
    registerMonitor(program, deps)
    registerTailMonitor(program, deps)
}

module.exports = { configureRootOptions, registerLifecycleCommands, registerStreamCommands }
