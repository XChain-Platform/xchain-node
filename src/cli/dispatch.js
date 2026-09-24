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

function dispatchSettings(config) {
    const commandsNeedingVersions = ['install', 'update', 'reinstall']
    // Read-only commands only display state and never change which services
    // are installed/running, so they don't need to push local config to the
    // hub/explorer. Skipping the push keeps them fast and avoids the lengthy
    // updateconfig round-trip on multi-coin nodes. Any command NOT listed here
    // (install, update, start, stop, restart, uninstall, reset, sync, …) still
    // pushes; the default is to sync, so a new/unknown command stays safe.
    const readOnlyCommands = ['ps', 'tail', 'logs', 'monitor', 'tailmonitor', 'bootstrap-combos', 'bootstrap-republish-due']
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
    const LOCK_WAIT_MS = parseInt(config.XCHAIN_NODE_LOCK_WAIT_MS || '15000', 10) || 15000
    // How long a MUTATING command blocks for a lock holder before refusing. Zero
    // keeps the interactive contract below; an unattended caller sets it so a
    // scheduled run waits out a deploy instead of losing its work.
    const MUTATING_LOCK_WAIT_MS = parseInt(config.XCHAIN_NODE_MUTATING_LOCK_WAIT_MS || '0', 10) || 0
    return { commandsNeedingVersions, readOnlyCommands, mutatingCommands, LOCK_WAIT_MS, MUTATING_LOCK_WAIT_MS }
}

function skipsPreAction(actionCommand) {
    const commandName = actionCommand.name()
    // `validator` subcommands are offline (key generation + local config
    // file writes). They must NOT trigger the Docker/MariaDB precheck, so an
    // operator can prepare their validator identity before any stack is up.
    const parentName = actionCommand.parent && actionCommand.parent.name()
    if (commandName === 'validator' || parentName === 'validator') return true
    // `rollback` is declared but unimplemented: its action only names the
    // reset-and-restore recovery path and exits non-zero. Provisioning
    // Docker/MariaDB/hub and taking the mutating lock to reach a two-line
    // refusal is what made it read as a hang. Measured 2026-08-30 while
    // repairing a regtest indexer: an operator reached for `rollback`
    // mid-incident and waited ~10 minutes on a command that printed nothing.
    // It stays listed in mutatingCommands above so that a real
    // implementation, which would drop this early return, is serialized.
    if (commandName === 'rollback') return true
    // `bootstrap-republish-due` reads one local JSON file and prints it. It
    // must not provision Docker/MariaDB or take the command lock: the
    // publisher asks it on EVERY run, and a read-only command that waits out
    // a lock holder exits non-zero, which the publisher would read as "no
    // combo is due" and silently drop the forced republish this whole
    // mechanism exists to guarantee.
    return commandName === 'bootstrap-republish-due'
}

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
function commandLock(commandName, settings, acquireCommandLock) {
    const holdThroughAction = settings.mutatingCommands.includes(commandName)
    let release
    try {
        release = acquireCommandLock({
            command: commandName,
            waitMs: holdThroughAction ? settings.MUTATING_LOCK_WAIT_MS : settings.LOCK_WAIT_MS
        })
    } catch (err) {
        console.error(err.message)
        process.exit(1)
        return null
    }
    if (holdThroughAction) {
        // Release only on process exit (also covers throws and SIGINT/SIGTERM
        // via the default handlers ending the process).
        process.on('exit', release)
        process.on('SIGINT', () => process.exit(130))
        process.on('SIGTERM', () => process.exit(143))
    }
    return { holdThroughAction, release }
}

// The CLI moves itself BEFORE anything else runs for a release update:
// ahead of the lock (the re-executed child takes it), ahead of preCheck
// (the child's preCheck is the one that should run, at the new code).
// Nothing to do answers quickly and the command continues here.
//
// The ref the action is about to install at, so the hub preCheck
// provisions is staged from it too. Read with the SAME classifier
// the action uses rather than "the first positional", because the
// args are order-independent and only resolveArgs knows which one
// is a ref (`install regtest` names a network, not a branch). A
// command that names no ref, or an arg shape resolveArgs refuses,
// yields null and the previous default-branch behaviour.
//
// Whether this command could bring a crash-looping hub back, which
// is the only thing that lets preCheck's config push degrade to a
// warning instead of aborting the command that would fix the hub.
//
// Anonymous usage telemetry (default-on, opt-out). Fire-and-forget:
// a failure here must never block or break the command being run.
//
// One line when a newer release exists, on every command that reached
// this point. `update` is the command it recommends, so it says nothing
// there. Cached an hour, silent offline, never throws.
async function beforeAction(thisCommand, actionCommand, settings, deps) {
    const {
        setVerbose, maybeSelfUpdateBeforeUpdate, redactSecrets,
        acquireCommandLock, preCheck, refForPreCheck, commandRepairsHub,
        maybeReportTelemetry, noticeNewerRelease
    } = deps
    setVerbose(thisCommand.opts().verbose ?? false)
    if (thisCommand.opts().verbose) console.log("Checking xchain-node structure")
    const commandName = actionCommand.name()
    if (skipsPreAction(actionCommand)) return

    if (commandName === 'update') {
        try {
            await maybeSelfUpdateBeforeUpdate(actionCommand.args || [])
        } catch (err) {
            console.error('update failed: ' + redactSecrets(err && err.message ? err.message : err))
            return process.exit(1)
        }
    }

    const lock = commandLock(commandName, settings, acquireCommandLock)
    if (!lock) return
    try {
        await preCheck(
            settings.commandsNeedingVersions.includes(commandName),
            !settings.readOnlyCommands.includes(commandName),
            refForPreCheck(commandName, actionCommand),
            commandRepairsHub(commandName, actionCommand)
        )
    } finally {
        // Non-mutating commands hand the lock back as soon as provisioning is
        // done; mutating commands keep it (released on exit) for their action.
        if (!lock.holdThroughAction) lock.release()
    }
    try {
        const optOut = thisCommand.opts().telemetry === false
        await maybeReportTelemetry(actionCommand.name(), optOut)
    } catch { /* telemetry is best-effort */ }
    if (commandName !== 'update') {
        await noticeNewerRelease()
    }
}

function installDispatch(program, deps) {
    const settings = dispatchSettings(deps.config)
    program.hook('preAction', (thisCommand, actionCommand) =>
        beforeAction(thisCommand, actionCommand, settings, deps))
}

module.exports = { installDispatch }
