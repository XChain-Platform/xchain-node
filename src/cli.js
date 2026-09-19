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
const { filterCommandParameters, resolveArgs } = require('./services/config_service')
const config = require('./config')
const { HUB_MODULE_NAME } = config
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
    clearDecoderReorgHalt,
    shellModule,
    runE2ETest,
    resetModules
} = require('./operations/module_operations')
const { getStatus }            = require('./services/status_service')
const { scanAndRegisterModules } = require('./services/discovery_service')
const { maybeReportTelemetry } = require('./services/telemetry_service')
const { makeBootstrap, listServedBootstrapCombos } = require('./services/bootstrap_service')
const { listRepublishDue } = require('./services/bootstrap_republish_ledger')
const { initValidator, getValidatorSettings, isInitialized, getCapabilityConfigHostPath,
        readWallets, publicWalletInfo, getSignerMountDir, COIN_NETWORKS, WALLETS_FILE,
        getRollcallStatus, capabilityDriftReport, capabilityDriftExitCode,
        formatCapabilityDrift } = require('./services/validator_service')
const { stakeValidator, unstakeValidator } = require('./services/validator_stake_service')
const { restoreBootstrapInterface, startInterface } = require('./ui/menu')
const { acquireCommandLock } = require('./utils/command_lock')
const { noticeNewerRelease } = require('./services/self_update_service')
const { runParseCommand } = require('./cli/parse_command')
const { installUnhandledRejectionHandler, installUncaughtExceptionHandler } = require('./cli/errors')
const loadModule = require

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

// The verbs that can put the hub container back: they rebuild it, recreate it
// from its config, replace its image, or remove it so the next precheck
// reinstalls one. Naming the verb is only half the test; the command must also
// TARGET the hub, which commandRepairsHub decides below.
const HUB_TARGETING_COMMANDS = ['install', 'update', 'recreate', 'restart', 'start', 'uninstall']

// Would the command about to run repair the hub?
//
// preCheck pushes local config to the hub before every state-changing command.
// A hub that is crash-looping answers nothing, so that push fails and aborts the
// command - including `update xchain-hub`, the command that would rebuild it and
// end the crash loop. The only escape was deleting the container by hand. This
// tells preCheck which commands may proceed on a warning instead of that abort;
// everything else still fails loudly against a hub that is down.
//
// Deliberately narrow, because the answer buys a skipped config push: the verb
// must replace or restart container state AND the target must resolve to the hub
// itself. `stop` is not here (stopping repairs nothing), nor is `reset`, `sync`,
// `bootstrap`, `exec` or `e2etest` (they read or write through a hub they need
// working). Targeting is delegated to resolveArgs, the same classifier the
// actions use, so the two cannot disagree about which positional is the service.
function commandRepairsHub(commandName, actionCommand) {
    // `autoheal` exists to restart containers that are unhealthy, the hub
    // included, and takes no service argument to read.
    if (commandName === 'autoheal') return true
    if (!HUB_TARGETING_COMMANDS.includes(commandName)) return false

    let resolved
    try {
        resolved = resolveArgs((actionCommand && actionCommand.args) || [], {
            expectBranch: commandName === 'install' || commandName === 'update',
            defaultBranch: null
        })
    } catch {
        // An argument shape resolveArgs refuses is not a repair anyone can prove,
        // and the action reports the refusal itself with better context.
        return false
    }
    if (resolved.service === HUB_MODULE_NAME) return true
    if (resolved.service !== 'all') return false

    // `all` reaches the hub on exactly two verbs. `update all` folds the shared
    // services in ahead of the coin stacks (moduleOperations
    // includeSharedServicesForUpdate), and `uninstall --include-shared` asks for
    // them by name. Everywhere else `all` expands to the coin stacks plus the
    // explorer and never touches the hub container, so it must not buy the skip.
    if (commandName === 'update') return true
    if (commandName === 'uninstall') {
        const opts = (actionCommand && typeof actionCommand.opts === 'function') ? actionCommand.opts() : {}
        return opts.includeShared === true
    }
    return false
}

/**
 * For an `update` that targets a release, move the CLI to that release first
 * and re-execute the command there (SelfUpdateService). Returns normally when
 * the CLI is already there, is not a checkout, is told not to, or the update
 * targets a branch; the command then continues in this process.
 *
 * The target is decided the same way updateModules will decide it: a
 * release ref names the release; no ref means the latest release on a
 * release node and no self-update on a branch node.
 */
async function maybeSelfUpdateBeforeUpdate(args, deps = {}) {
    const { isReleaseRef, resolveLatestReleaseTag } = deps.manifest || require('./services/release_manifest_service')
    const { resolveUpdateTarget } = deps.installTarget || require('./services/install_target_service')
    const selfUpdate = deps.selfUpdate || require('./services/self_update_service')

    let resolved
    try {
        resolved = resolveArgs(args, { expectBranch: true, defaultBranch: null })
    } catch {
        return { moved: false, reason: 'unparsed-args' } // the action reports it
    }
    if (config.XCHAIN_NODE_UPDATE_TARGET) return { moved: false, reason: 'already-reexecuted' }
    if (selfUpdate.selfUpdateDisabled()) return { moved: false, reason: 'disabled' }

    let tag = null
    if (isReleaseRef(resolved.branch)) {
        tag = resolved.branch.trim()
    } else if (!resolved.branch) {
        const target = await resolveUpdateTarget()
        if (target.kind !== 'release') return { moved: false, reason: 'branch-node' }
        tag = await resolveLatestReleaseTag()
        if (!tag) return { moved: false, reason: 'no-release' }
    } else {
        return { moved: false, reason: 'branch-update' }
    }

    // Serialized like every mutator, so two concurrent updates cannot both
    // move the checkout. The lock is handed back right before the re-exec so
    // the child, which takes its own lock in this same hook, is not refused
    // by its parent.
    const lock = deps.acquireCommandLock || acquireCommandLock
    const release = lock({ command: 'update (self-update)', waitMs: 0 })
    let outcome
    try {
        outcome = await selfUpdate.selfUpdateAndReexec({
            tag,
            childArgs: selfUpdate.explicitUpdateArgs(resolved, tag),
            deps: { ...(deps.selfUpdateDeps || {}), beforeSpawn: release }
        })
    } finally {
        release()
    }
    // The run continues in this process at the resolved tag: hand it on so
    // updateModules does not resolve the latest release a second time.
    if (outcome && !outcome.moved) config.XCHAIN_NODE_UPDATE_TARGET = tag
    return outcome
}

async function parseCommand() {
    runParseCommand({
        Command, version, preCheck, setVerbose, filterCommandParameters, resolveArgs,
        HUB_MODULE_NAME, redactSecrets, installModules, syncSharedServicesAfterInstall,
        updateModules, recreateModules, uninstallModules, logModules, monitorModules,
        restartModules, stopModules, startModules, execModules, clearDecoderReorgHalt,
        shellModule, runE2ETest, resetModules, getStatus, scanAndRegisterModules,
        maybeReportTelemetry, makeBootstrap, listServedBootstrapCombos, listRepublishDue,
        initValidator, getValidatorSettings, isInitialized, getCapabilityConfigHostPath,
        readWallets, publicWalletInfo, getSignerMountDir, COIN_NETWORKS, WALLETS_FILE,
        getRollcallStatus, capabilityDriftReport, capabilityDriftExitCode,
        formatCapabilityDrift, stakeValidator, unstakeValidator,
        restoreBootstrapInterface, startInterface, acquireCommandLock,
        noticeNewerRelease, refForPreCheck, commandRepairsHub,
        maybeSelfUpdateBeforeUpdate, loadModule, config
    })
}

// installUnhandledRejectionHandler and installUncaughtExceptionHandler are
// exported for their unit tests only; the CLI installs both itself at the top
// of parseCommand().
// refForPreCheck is exported for its unit test: it decides which tree the hub is
// built from, and the defect it fixes was invisible in every log until a deploy
// line named the wrong branch.
// commandRepairsHub is exported for the same reason: it decides which commands
// survive a hub that is not answering, and getting it wrong either wedges the
// repair path again or silences a real hub failure.
module.exports = { parseCommand, installUnhandledRejectionHandler, installUncaughtExceptionHandler, refForPreCheck, commandRepairsHub, maybeSelfUpdateBeforeUpdate }

// Allow running this file directly (`node src/cli.js <cmd>`) as well as via the
// bin entrypoint `src/index.js`. When cli.js is required as a module (index.js
// does `require('./cli')`), require.main is the entrypoint, not this file, so
// parseCommand is NOT auto-invoked here and index.js remains the single caller.
// Running it directly otherwise silently does nothing, because program.parse()
// lives inside parseCommand() and would never be called.
if (require.main === module) {
    loadModule('dotenv').config()
    parseCommand()
}
