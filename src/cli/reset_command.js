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
 * The `reset` command: per-chain service resets and hub-checkpoints
 ********************************************************************/

// resetHubCheckpoints is handed in by cli/errors.js, which defines it and registers this command.
function registerReset(program, deps, resetHubCheckpoints) {
    const { resetModules } = deps
    program
        .command('reset')
        .description('Reset data for a specific service or all services of a coin/network')
        .argument('<service>', '(node, xchain-utxo-tracker, xchain-decoder, xchain-indexer, all, hub-checkpoints)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin); omit for hub-checkpoints')
        .argument('[network]', '(mainnet, testnet, regtest); omit for hub-checkpoints')
        .option('--yes', 'Skip the destructive-reset confirmation prompt (for CI/scripted resets)')
        .option('--with-indexer', 'Reset xchain-indexer alongside xchain-decoder; the pair is only coherent when both move together')
        .option('--db-container <name>', 'Run the database steps on this MariaDB container, for a stack this CLI did not install; finds its services by container name and skips the hub and explorer config push (xchain-decoder and xchain-indexer only)')
        .option('--check', 'With --db-container: check the server, its root login and the target databases, then stop before anything is stopped or changed')
        .action(async (service, chain, network, options) => {
            if (options && options.check && !options.dbContainer) {
                process.stderr.write('reset: --check needs --db-container\n')
                return process.exit(1)
            }
            if (service === 'hub-checkpoints') {
                if (options && options.dbContainer) {
                    process.stderr.write('reset: --db-container does not apply to hub-checkpoints\n')
                    return process.exit(1)
                }
                if (chain || network) {
                    process.stderr.write('reset: hub-checkpoints does not take a chain or network\n')
                    return process.exit(1)
                }
                const completed = await resetHubCheckpoints(!!(options && options.yes), deps.hubCheckpointDependencies)
                return process.exit(completed ? 0 : 1)
            }
            if (service !== 'hub-checkpoints' && (!chain || !network)) {
                process.stderr.write('reset: chain and network are required unless service is hub-checkpoints\n')
                return process.exit(1)
            }
            // Passed only when given, so a reset without the flag calls resetModules exactly as before.
            const overrideArgs = options && options.dbContainer ? [{ dbContainer: options.dbContainer, check: !!options.check }] : []
            const confirmed = await resetModules(service, chain, network,
                !!(options && options.yes), !!(options && options.withIndexer), ...overrideArgs)
            return process.exit(confirmed ? 0 : 1)
        })

}

module.exports = { registerReset }
