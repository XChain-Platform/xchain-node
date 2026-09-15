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
 * Loads src/services/docker_service.js under proxyquire with one stub set
 * that reaches every part the module is built from.
 *
 * WHY THE PARTS ARE LOADED FIRST. proxyquire hands a stub only to the module
 * it loads directly. The entry re-exports functions that live in
 * src/services/docker_service/, and those parts require child_process, fs,
 * blessed and the config home themselves, so a stub given to the entry alone
 * never reaches the code a test exercises. Each part is loaded under the same
 * stubs first, and the loaded parts are then handed to the entry as stubs for
 * its own part requires.
 *
 * Relative stub keys are written against the entry's directory (for example
 * '../config/index'), so they are resolved to absolute paths before a part one
 * directory deeper is loaded with them.
 *
 ********************************************************************/

const path       = require('path')
const proxyquire = require('proxyquire').noCallThru()

// Every part the entry requires, by the require string the entry uses.
const PART_REQUESTS = [
    './docker_service/environment_checks.js',
    './docker_service/networks_and_files.js',
    './docker_service/container_logs.js'
]

/**
 * The docker service with `stubs` applied to the entry and to every part.
 *
 * @param {string} entryPath absolute path of src/services/docker_service
 *   (with or without the .js extension)
 * @param {object} stubs proxyquire stubs keyed as the entry would require them
 * @returns {object} the entry's exports, built from stubbed parts
 */
function proxyquireDockerService(entryPath, stubs) {
    const entryDir = path.dirname(entryPath)
    const partStubs = {}
    for (const [request, stub] of Object.entries(stubs)) {
        partStubs[request.startsWith('.') ? path.resolve(entryDir, request) : request] = stub
    }
    const entryStubs = { ...stubs }
    for (const request of PART_REQUESTS) {
        entryStubs[request] = proxyquire(path.resolve(entryDir, request), partStubs)
    }
    return proxyquire(entryPath, entryStubs)
}

module.exports = { proxyquireDockerService }
