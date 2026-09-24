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
function registerInstall(program, deps) {
    const { filterCommandParameters, resolveArgs, installModules, syncSharedServicesAfterInstall, config } = deps
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
            if (program.opts().bootstrap === false) config.XCHAIN_NODE_NO_BOOTSTRAP = '1'
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

}

function registerUninstall(program, deps) {
    const { filterCommandParameters, uninstallModules, redactSecrets } = deps
    program
        .command('uninstall')
        .description('Uninstall XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .option('--include-shared', 'Also uninstall shared services (database, xchain-hub, xchain-explorer, xchain-sync)')
        .action(async (service, chain, network, options) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            // A module that failed to uninstall must not be printed and forgotten,
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

}

function registerUpdate(program, deps) {
    const { filterCommandParameters, resolveArgs, updateModules, redactSecrets } = deps
    program
        .command('update')
        .description('Update XChain services (and the CLI itself) to the latest release, or to a named release or branch')
        // Every positional is optional: `xchain-node update` alone is the
        // documented upgrade and means `update all`. The ref keeps its one
        // order-independent slot, classified by shape like `install`.
        .argument('[service]', '(node, xchain-hub, xchain-sync, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .argument('[ref]',     '(a release like v0.9.0 for a pinned update, or any branch name; a branch is resolved on the module\'s remote, so push it first, or point the module at a local path with XCHAIN_NODE_MODULES_URLS_OVERRIDE. Omit to move a release node to the latest release, or a branch node to its newest commits)')
        .action(async (service, chain, network, branch) => {
            const resolved = resolveArgs([service, chain, network, branch], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            // Report a failed update as an error and exit non-zero instead of
            // letting it escape as an unhandled rejection. The deploy checkout
            // is left intact by cloneGit, so the message is the whole outcome:
            // nothing to roll back by hand.
            let outcome
            try {
                outcome = await updateModules(serviceList, resolved.branch, { all: resolved.service === 'all' })
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

}

function registerRecreate(program, deps) {
    const { filterCommandParameters, recreateModules, getStatus, redactSecrets } = deps
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

}

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
            await execModules(serviceList, command)
            return process.exit(0)
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
            const serviceList = filterCommandParameters(null, 'xchain-decoder', chain, network)
            const ok = await clearDecoderReorgHalt(serviceList, {
                reason: options.reason, force: !!options.force, dryRun: !!options.dryRun
            })
            return process.exit(ok ? 0 : 1)
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
            if (service === "all" || chain === "all" || network === "all") {
                console.log("The shell command can't be used for multiple containers, 'all' is invalid")
                return process.exit(0)
            }
            const serviceList = filterCommandParameters(null, service, chain, network)
            await shellModule(serviceList)
            return process.exit(0)
        })

}

function registerPrimaryCommands(program, deps) {
    registerInstall(program, deps)
    registerUninstall(program, deps)
    registerUpdate(program, deps)
    registerRecreate(program, deps)
}

function registerToolCommands(program, deps) {
    registerExec(program, deps)
    registerClearReorgHalt(program, deps)
    registerShell(program, deps)
}

module.exports = { registerPrimaryCommands, registerToolCommands }
