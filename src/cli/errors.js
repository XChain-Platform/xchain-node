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

function registerReset(program, deps) {
    const { resetModules } = deps
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
    registerReset(program, deps)
}

function registerRecoveryCommands(program, deps) {
    registerRollback(program)
    registerBootstrap(program, deps)
}

module.exports = {
    installUnhandledRejectionHandler,
    installUncaughtExceptionHandler,
    registerPreRecoveryCommands,
    registerRecoveryCommands
}
