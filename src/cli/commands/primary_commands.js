/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

function registerInstall(program, deps) {
    const { filterCommandParameters, resolveArgs, installModules, syncSharedServicesAfterInstall, config } = deps
    program
        .command('install')
        .description('Installs XChain services')
        // One order-independent ref slot accepts a release or branch. An
        // omitted ref resolves the latest published release.
        .argument('[ref]',     '(a release like v0.9.0, or a branch like master/develop; omit for the latest release)')
        .argument('[service]', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (branch, service, chain, network, options, actionCommand) => {
            // Commander assigns a global option to the root program, so read it
            // there before deciding whether bootstrap is enabled.
            if (program.opts().bootstrap === false) config.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            const resolved = resolveArgs([branch, service, chain, network], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            const installed = await installModules(serviceList, resolved.branch, actionCommand.resolvedInstallTarget || null)
            const usable = await syncSharedServicesAfterInstall(installed)
            return process.exit(usable ? 0 : 1)
        })
}

function registerUninstall(program, deps) {
    const { filterCommandParameters, uninstallModules, redactSecrets } = deps
    program
        .command('uninstall')
        .description('Uninstall XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, xchain-hub, xchain-sync, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .option('--include-shared', 'Also uninstall shared services (xchain-explorer, xchain-sync, xchain-hub) once no chain/network is still installed; the database is never removed and must be removed manually')
        .action(async (service, chain, network, options) => {
            const serviceList = filterCommandParameters(null, service, chain, network, { includeSharedExplorer: false })
            try {
                await uninstallModules(serviceList, options.includeShared, { all: service === 'all' })
            } catch (err) {
                console.error('uninstall failed: ' + redactSecrets(err && err.message ? err.message : err))
                return process.exit(1)
            }
            return process.exit(0)
        })
}

function updateFailureMessage(outcome, redactSecrets) {
    if (Array.isArray(outcome.updated) && outcome.updated.length === 0) {
        const why = (outcome.skipped || [])
            .map(item => `${item.module} (${item.coin} ${item.network}): ${item.reason}`)
            .join('; ')
        return 'update failed: nothing was updated' +
            (why ? ' - ' + why : ' (no requested service matched an installed container)')
    }
    if (!Array.isArray(outcome.failed) || outcome.failed.length === 0) return null
    const updated = outcome.updated
        .map(item => `${item.module} (${item.coin} ${item.network})`)
        .join('; ')
    const why = outcome.failed
        .map(item => `${item.module} (${item.coin} ${item.network}): ${item.reason}`)
        .join('; ')
    return 'update: partially failed - updated: ' + updated + '; failed: ' + redactSecrets(why)
}

function registerUpdate(program, deps) {
    const { filterCommandParameters, resolveArgs, updateModules, redactSecrets } = deps
    program
        .command('update')
        .description('Update XChain services (and the CLI itself) to the latest release, or to a named release or branch')
        .argument('[service]', '(node, xchain-hub, xchain-sync, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .argument('[ref]',     '(a release like v0.9.0 for a pinned update, or any branch name; a branch is resolved on the module\'s remote, so push it first, or point the module at a local path with XCHAIN_NODE_MODULES_URLS_OVERRIDE. Omit to move a release node to the latest release, or a branch node to its newest commits)')
        .action(async (service, chain, network, branch) => {
            const resolved = resolveArgs([service, chain, network, branch], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            let outcome
            try {
                outcome = await updateModules(serviceList, resolved.branch, { all: resolved.service === 'all' })
            } catch (err) {
                console.error('update failed: ' + redactSecrets(err && err.message ? err.message : err))
                return process.exit(1)
            }
            const failure = outcome && updateFailureMessage(outcome, redactSecrets)
            if (failure) {
                console.error(failure)
                return process.exit(1)
            }
            return process.exit(0)
        })
}

function recreateFailureMessage(outcome) {
    if (outcome && Array.isArray(outcome.recreated) && outcome.recreated.length > 0) return null
    const why = ((outcome && outcome.skipped) || [])
        .map(item => `${item.module} (${item.coin} ${item.network}): ${item.reason}`)
        .join('; ')
    return 'recreate failed: nothing was recreated' +
        (why ? ' - ' + why : ' (no requested service can be recreated from the config map)')
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
            const failure = recreateFailureMessage(outcome)
            if (failure) {
                console.error(failure)
                return process.exit(1)
            }
            await getStatus(null, null, true)
            return process.exit(0)
        })
}

function registerPrimaryCommands(program, deps) {
    registerInstall(program, deps)
    registerUninstall(program, deps)
    registerUpdate(program, deps)
    registerRecreate(program, deps)
}

module.exports = { registerPrimaryCommands }
