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
 *
 * XChain Node - the one logger
 *
 * WHAT THIS IS FOR, AND WHAT IT IS DELIBERATELY NOT. This repo is a command
 * line tool, so it has two kinds of output and only one of them belongs here.
 * The prints a person reads because they ran a command (the menus, the help,
 * the install narration, the precheck report) are the PRODUCT, and they stay
 * exactly where they are, in src/ui/, src/cli.js, src/operations/ and
 * src/precheck.js, as raw console calls whose text is pinned. Everything else
 * (the service layer talking about what it is doing to containers, databases
 * and archives) is a LOG, and a log wants a level, a place to go and one
 * decision about verbosity. That second population is what comes through here.
 *
 * WHY IT WRITES TO THE STREAMS AND NOT THROUGH console. A logger that calls
 * console.log is a logger that can be patched out from under itself by
 * anything else that patches console, and it also reads to every checker as
 * one more raw print in a file that is supposed to have none. Writing the
 * stream directly is the same bytes with none of that ambiguity.
 *
 * WHY THE ACCESSOR IS A FUNCTION. A module can write `const log = getLogger()`
 * at require time and still see a later verbosity change, because the object
 * it gets back reads the setting at call time rather than closing over it.
 * There is exactly one such object per process.
 *
 * THE SHAPE IS THE SHAPE console ALREADY HAD. Arguments go through
 * util.format, so a call that used to print an object, an error or a format
 * string prints the same characters it printed before.
 *
 ********************************************************************/

const util = require('util')

// debug is the only level a normal run hides, and the CLI's -v flag is what
// reveals it. Everything else is something the operator should see happen.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold = LEVELS.info

/**
 * Show or hide the debug level. Called once by the CLI from its verbose flag;
 * nothing else should need it.
 *
 * @param {boolean} on true to let debug lines through
 */
function setVerbose(on) {
    threshold = on ? LEVELS.debug : LEVELS.info
}

/** Whether debug lines are currently being written. */
function isVerbose() {
    return threshold <= LEVELS.debug
}

// Warnings and errors go to stderr so a scriptable command's stdout stays
// parseable when something goes wrong halfway through it.
function write(level, args) {
    if (LEVELS[level] < threshold) return
    const line = util.format(...args)
    const stream = (level === 'warn' || level === 'error') ? process.stderr : process.stdout
    stream.write(line + '\n')
}

// One object for the whole process. It holds no state of its own: the level
// threshold lives in this module, so a caller that grabbed the object early
// still honours a verbosity set later.
const logger = {
    debug(...args) { write('debug', args) },
    info(...args)  { write('info',  args) },
    warn(...args)  { write('warn',  args) },
    error(...args) { write('error', args) }
}

/**
 * The logger. Always the same object, so requiring this module early is safe.
 *
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function getLogger() {
    return logger
}

module.exports = { getLogger, setVerbose, isVerbose }
