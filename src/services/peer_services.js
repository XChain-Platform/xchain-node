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
 * XChain Node - Peer Services
 *
 * The services call each other in both directions: ConfigService asks
 * DatabaseService for the container id while DatabaseService is built on
 * ConfigService, StatusService pushes config through HubService while
 * HubService reads StatusService, and so on. A file-scope require on both
 * sides of such a pair hands one of them a half-loaded exports object, so
 * the calls that run against the load order are resolved here instead, when
 * they are first used, and every one of them is named in the table below.
 *
 * WHY THE CALLER PASSES ITS OWN require. Resolution goes through the calling
 * file's require function, so it answers exactly what a require written in
 * that file would: the same module cache, the same exports object a sinon
 * stub was installed on, and the stub a test gave proxyquire for that file.
 ********************************************************************/

// The services a caller reaches against the load order, by the name it reads
// them under. A service belongs here only when it requires, at load, a file
// that calls it; anything else is a plain require at the top of the caller.
const PEER_SERVICE_FILES = Object.freeze({
    bootstrapHealthGate: './bootstrap_health_gate',
    databaseService:     './database_service',
    explorerService:     './explorer_service',
    hubService:          './hub_service',
    moduleService:       './module_service',
    validatorService:    './validator_service'
})

/**
 * A read-only view whose properties resolve each peer service on access.
 *
 * @param {Function} requireFrom the calling file's own require
 * @returns {Object<string, object>} one getter per PEER_SERVICE_FILES entry
 */
function bindPeerServices(requireFrom) {
    const peers = {}
    for (const [name, file] of Object.entries(PEER_SERVICE_FILES)) {
        Object.defineProperty(peers, name, { enumerable: true, get: () => requireFrom(file) })
    }
    return Object.freeze(peers)
}

module.exports = {
    PEER_SERVICE_FILES,
    bindPeerServices
}
