/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Where a cloned module tree keeps its tracked migrations, and what they are.
 *
 * The indexer keeps them under src/db/sql/migrations/, grouped into bucket
 * directories of at most twenty files. The decoder, and every indexer ref cut
 * before that move, keep them flat under src/sql/migrations/. One xchain-node
 * release has to deploy refs from both sides of the move, so the cloned tree
 * answers for itself rather than this tool assuming one layout.
 *
 * A schema_migrations ledger row is keyed by the migration's basename alone,
 * so the listing below returns basenames and keeps the path beside each one;
 * the bucket a file sits in never changes what the ledger calls it.
 *********************************************************************/

'use strict'

const fs   = require('fs')
const path = require('path')

/**
 * The migrations directory of a module checkout at `root`: the moved home when
 * the tree carries it, otherwise the flat one. The flat path is returned even
 * when it does not exist, so a caller's missing-directory handling still runs.
 */
function migrationsDirOf(root) {
    const moved = path.join(root, 'src', 'db', 'sql', 'migrations')
    return fs.existsSync(moved) ? moved : path.join(root, 'src', 'sql', 'migrations')
}

/**
 * Every .sql migration in `dir`, flat or one bucket directory down, as
 * [basename, file path] pairs sorted by basename, which is the order the
 * modules' runners apply them in. A missing directory yields [].
 */
function migrationFiles(dir) {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
    const out = []
    for (const entry of entries) {
        const at = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...fs.readdirSync(at).map(f => [f, path.join(at, f)]))
        else out.push([entry.name, at])
    }
    return out.filter(([name]) => name.endsWith('.sql')).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

module.exports = { migrationsDirOf, migrationFiles }
