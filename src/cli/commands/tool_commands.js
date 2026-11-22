/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

const config = require('../../config')

function registerExec(program, deps) {
    const { filterCommandParameters, execModules } = deps
    program
        .command('exec')
        .description('Execute command on XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .argument('<command>', 'The shell command to execute')
        .action(async (service, chain, network, command) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            const ok = await execModules(serviceList, command)
            return process.exit(ok === true ? 0 : 1)
        })
}

function registerClearReorgHalt(program, deps) {
    const { filterCommandParameters, clearDecoderReorgHalt } = deps
    program
        .command('clear-reorg-halt')
        .description('Clear a decoder\'s durable REORG_HALT marker after verifying the database is intact; the reason is recorded in its events table')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .option('--reason <text>', 'Why this database is known good (recorded with the clear; required unless --dry-run)')
        .option('--force', 'Clear a database that has held dispenser state; you have compared its dispensers table against a known-good replica')
        .option('--dry-run', 'Run the checks and report the verdict without writing the clear')
        .action(async (chain, network, options) => {
            if (chain === 'all' || network === 'all') {
                console.log("clear-reorg-halt takes one chain and one network; 'all' is invalid")
                return process.exit(1)
            }
            const bad = [['chain', chain, config.Coin], ['network', network, config.Network]]
                .find(([, value, known]) => !Object.values(known).includes(value))
            if (bad) {
                console.log(`clear-reorg-halt: unknown ${bad[0]} '${bad[1]}'; expected one of ${Object.values(bad[2]).join(', ')}`)
                return process.exit(1)
            }
            const serviceList = filterCommandParameters(null, 'xchain-decoder', chain, network)
            const ok = await clearDecoderReorgHalt(serviceList, {
                reason: options.reason, force: !!options.force, dryRun: !!options.dryRun
            })
            return process.exit(ok ? 0 : 1)
        })
}

function registerRestoreDump(program, deps) {
    const { restoreDump, redactSecrets } = deps
    program
        .command('restore-dump')
        .description('Restore an xchain-backup.sh .sql.gz dump into one service database')
        .argument('<service>', '(xchain-decoder, xchain-indexer)')
        .argument('<chain>', '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .requiredOption('--file <path>', 'path to the xchain-backup.sh .sql.gz dump')
        .option('--yes', 'confirm replacing the service database without prompting')
        .option('--allow-mainnet', 'allow a mainnet database restore')
        .action(async (service, chain, network, options) => {
            try {
                await restoreDump(service, chain, network, {
                    file: options.file,
                    yes: options.yes === true,
                    allowMainnet: options.allowMainnet === true
                })
                return process.exit(0)
            } catch (err) {
                console.error('restore-dump failed: ' + redactSecrets(err && err.message ? err.message : err))
                return process.exit(1)
            }
        })
}

function registerShell(program, deps) {
    const { filterCommandParameters, shellModule } = deps
    program
        .command('shell')
        .description('Shell into a XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .action(async (service, chain, network) => {
            if (service === 'all' || chain === 'all' || network === 'all') {
                console.log("The shell command can't be used for multiple containers, 'all' is invalid")
                return process.exit(0)
            }
            const serviceList = filterCommandParameters(null, service, chain, network)
            await shellModule(serviceList)
            return process.exit(0)
        })
}

function registerToolCommands(program, deps) {
    registerExec(program, deps)
    registerClearReorgHalt(program, deps)
    registerRestoreDump(program, deps)
    registerShell(program, deps)
}

module.exports = { registerToolCommands }
