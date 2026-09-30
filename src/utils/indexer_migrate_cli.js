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
 * XChain Node - Indexer migrate CLI location
 * Where xchain-indexer's operator migration CLI sits inside a running
 * container, and which of its known paths the last read of that container
 * found.
 ********************************************************************/

// Newest first. In v0.19.0 the indexer moved the CLI from the top of src/ into
// src/db/migration/ alongside the rest of the db layer. The deploy guard reads
// the container being REPLACED, which can run a build from either layout, so
// both spellings stay readable for as long as a supported indexer build
// carries them.
const MIGRATE_CLI_PATHS = ['src/db/migration/migrate.js', 'src/migrate.js']

// Container name -> the path its last successful read answered at. The remedy
// the refusal prints runs on THAT build, so it has to name the path the read
// found there rather than the layout of the source about to be deployed.
const foundPaths = new Map()

/** Locate the first readable migrate CLI path known for this container build. */
async function readMigrateCli(cat, container) {
    for (const cliPath of MIGRATE_CLI_PATHS) {
        let source = null
        try {
            source = await cat(container, cliPath)
        } catch {
            source = null
        }
        if (source) {
            foundPaths.set(container, cliPath)
            return { cliPath, source: String(source) }
        }
    }
    foundPaths.delete(container)
    return null
}

/**
 * The CLI path a remedy for `container` should name: the one its last read
 * found. With no successful read the refusal tells the operator NOT to run the
 * CLI, and the newest layout is the one to name there.
 */
function migrateCliPathFor(container) {
    return foundPaths.get(container) || MIGRATE_CLI_PATHS[0]
}

module.exports = {
    MIGRATE_CLI_PATHS,
    readMigrateCli,
    migrateCliPathFor
}
