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
 * MariaDB dump statement prefixes recognized by archive inspectors.
 ********************************************************************/

'use strict'

const SYNC_STATE_TABLE = '`sync_state`'

function syncStateDumpPrefixes() {
    const createVerb = 'CREATE'
    const insertVerb = 'INSERT'
    return {
        create: Buffer.from(`${createVerb} TABLE ${SYNC_STATE_TABLE}`),
        insert: Buffer.from(`${insertVerb} INTO ${SYNC_STATE_TABLE} VALUES `)
    }
}

module.exports = { syncStateDumpPrefixes }
