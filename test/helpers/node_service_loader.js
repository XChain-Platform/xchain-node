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
 * Loads src/services/node_service.js under proxyquire with one stub set
 * that reaches every part the module is built from.
 *
 * WHY THE PARTS ARE LOADED FIRST. proxyquire hands a stub only to the module
 * it loads directly. The entry re-exports functions that live in
 * src/services/node_service/, and those parts require child_process, fs, the
 * config home and the peer services themselves, so a stub given to the entry
 * alone never reaches the code a test exercises. Each part is loaded under the
 * same stubs first, and the loaded parts are then handed to the entry as stubs
 * for its own part requires.
 *
 * Parts load in the order listed, and each loaded part is added to the stubs
 * the next part sees, so the build part runs against the stubbed stop part
 * rather than a second, unstubbed copy of it.
 *
 * Relative stub keys are written against the entry's directory (for example
 * '../config'), so they are resolved to absolute paths before a part one
 * directory deeper is loaded with them.
 *
 ********************************************************************/

const path       = require('path')
const proxyquire = require('proxyquire').noCallThru()

// Every part the entry requires, by the require string the entry uses, in
// load order: a part may require one listed before it.
const PART_REQUESTS = [
    './node_service/node_stop.js',
    './node_service/crypto_node_download.js',
    './node_service/crypto_node_build.js'
]

/**
 * The node service with `stubs` applied to the entry and to every part.
 *
 * @param {string} entryPath absolute path of src/services/node_service
 *   (with or without the .js extension)
 * @param {object} stubs proxyquire stubs keyed as the entry would require them
 * @returns {object} the entry's exports, built from stubbed parts
 */
function proxyquireNodeService(entryPath, stubs) {
    const entryDir = path.dirname(entryPath)
    const partStubs = {}
    for (const [request, stub] of Object.entries(stubs)) {
        partStubs[request.startsWith('.') ? path.resolve(entryDir, request) : request] = stub
    }
    const entryStubs = { ...stubs }
    for (const request of PART_REQUESTS) {
        const part = proxyquire(path.resolve(entryDir, request), partStubs)
        partStubs[path.resolve(entryDir, request)] = part
        entryStubs[request] = part
    }
    return proxyquire(entryPath, entryStubs)
}

module.exports = { proxyquireNodeService }
