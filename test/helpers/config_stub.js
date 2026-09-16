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
 * A stub of the config home that is still ALIVE to the environment.
 *
 * WHY A SPREAD IS THE WRONG TOOL HERE. Every environment variable the config
 * home exposes is a getter, because the value has to be read when the caller
 * runs rather than when the module loaded: a command composes a container's
 * environment and then reads it back, and a snapshot taken at require time
 * would answer with whatever happened to be set when the process started.
 * `{ ...config }` and `Object.assign({}, config)` both CALL every getter once
 * and freeze the answers, so a suite that sets process.env in a test and then
 * asks the stub gets the value from before its own setup ran. That failure is
 * silent: nothing throws, the assertion just compares the wrong thing.
 *
 * Copying property DESCRIPTORS instead keeps each getter a getter, so the stub
 * answers exactly as the real module would, and an explicit override still
 * wins because it is written over the top as a plain value.
 *
 ********************************************************************/

const realConfig = require('../../src/config')

/**
 * The config home as a stub object, with overrides applied.
 *
 * @param {object} [overrides] names to pin to a fixed value for one suite
 * @returns {object} a fresh object; the real module is never mutated
 */
function configStub(overrides = {}) {
    const copy = {}
    for (const name of Object.keys(realConfig)) {
        Object.defineProperty(copy, name, Object.getOwnPropertyDescriptor(realConfig, name))
    }
    // defineProperty, not assign: a getter copied above has no setter, and a
    // plain assignment over one throws instead of overriding it.
    for (const name of Object.keys(overrides)) {
        Object.defineProperty(copy, name, {
            value: overrides[name], writable: true, enumerable: true, configurable: true
        })
    }
    return copy
}

module.exports = { configStub }
