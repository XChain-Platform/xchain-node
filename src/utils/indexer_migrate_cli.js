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
 * found. The decoder's CLI is read the same way from its own paths.
 ********************************************************************/

const { XChainService } = require('../config/module_names')

// Newest first. In v0.19.0 the indexer moved the CLI from the top of src/ into
// src/db/migration/ alongside the rest of the db layer. The deploy guard reads
// the container being REPLACED, which can run a build from either layout, so
// both spellings stay readable for as long as a supported indexer build
// carries them.
const MIGRATE_CLI_PATHS = ['src/db/migration/migrate.js', 'src/migrate.js']

// Newest first. In v0.20.1 the decoder moved its CLI from the top of src/ into src/db/.
const DECODER_MIGRATE_CLI_PATHS = ['src/db/migrate.js', 'src/migrate.js']

/** The known CLI paths for a module's builds; every module but the decoder uses the indexer layout. */
function migrateCliPathsFor(module) {
    return module === XChainService.XCHAIN_DECODER ? DECODER_MIGRATE_CLI_PATHS : MIGRATE_CLI_PATHS
}

// Container name -> the path its last successful read answered at. The remedy
// the refusal prints runs on THAT build, so it has to name the path the read
// found there rather than the layout of the source about to be deployed.
const foundPaths = new Map()

/** Locate the first readable migrate CLI path known for this container build. */
async function readMigrateCli(cat, container, paths = MIGRATE_CLI_PATHS) {
    for (const cliPath of paths) {
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
function migrateCliPathFor(container, paths = MIGRATE_CLI_PATHS) {
    return foundPaths.get(container) || paths[0]
}

/**
 * Rows from the decoder CLI's `--status --json`, which names files as
 * {applied:[...], pending:[...]} instead of the indexer's counted rows, or null
 * when the response is not exactly that shape or the CLI has no --file. It
 * names no mode, so every pending file reads as manual: the list errs long.
 */
function decoderStatusRows(status, source) {
    if (!/(['"])--file\1/.test(source)) return null
    const isNameList = list => Array.isArray(list) && list.every(f => typeof f === 'string' && f.length > 0)
    if (!isNameList(status.applied) || !isNameList(status.pending)) return null
    const files = [...status.applied, ...status.pending]
    if (new Set(files).size !== files.length) return null
    const applied = new Set(status.applied)
    return files.sort().map(file => ({ file, applied: applied.has(file) }))
}

module.exports = {
    MIGRATE_CLI_PATHS,
    DECODER_MIGRATE_CLI_PATHS,
    migrateCliPathsFor,
    readMigrateCli,
    migrateCliPathFor,
    decoderStatusRows
}
