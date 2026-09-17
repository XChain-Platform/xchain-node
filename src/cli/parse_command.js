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

const { installDispatch } = require('./dispatch')
const { configureRootOptions, registerLifecycleCommands, registerStreamCommands } = require('./options')
const { registerPrimaryCommands, registerToolCommands } = require('./commands')
const { registerStatusCommands, registerValidatorCommands } = require('./output')
const {
    installUnhandledRejectionHandler,
    installUncaughtExceptionHandler,
    registerPreRecoveryCommands,
    registerRecoveryCommands
} = require('./errors')

function runParseCommand(deps) {
    installUnhandledRejectionHandler()
    installUncaughtExceptionHandler()
    const program = new deps.Command()

    installDispatch(program, deps)
    configureRootOptions(program, deps)
    registerPrimaryCommands(program, deps)
    registerStatusCommands(program, deps)
    registerLifecycleCommands(program, deps)
    registerStreamCommands(program, deps)
    registerToolCommands(program, deps)
    registerPreRecoveryCommands(program, deps)
    registerRecoveryCommands(program, deps)
    registerValidatorCommands(program, deps)

    program.parse(process.argv)
}

module.exports = { runParseCommand }
