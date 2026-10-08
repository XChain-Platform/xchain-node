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
 * XChain Node - Configured module database name
 ********************************************************************/

'use strict'

const { XChainService } = require('../config/module_names')
const { assertSafeDbIdentifier } = require('./sql_safety')

// Map each MariaDB-backed module to the config key that names its database.
const DATABASE_NAME_KEY = {
    [XChainService.XCHAIN_DECODER]: 'DECODER_DB_NAME',
    [XChainService.XCHAIN_INDEXER]: 'INDEXER_DB_NAME'
}

// Resolve the database a module's service actually uses: the operator-overridable
// config key provisioning grants on, else the derived default name. Bootstrap paths
// that read the default instead restore, dump or probe a database the service never reads.
function configuredDatabaseName(module, cfg, defaultName) {
    const key = DATABASE_NAME_KEY[module]
    const configured = key && cfg ? cfg[key] : undefined
    const name = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : defaultName
    return assertSafeDbIdentifier(name, 'database name')
}

module.exports = { DATABASE_NAME_KEY, configuredDatabaseName }
