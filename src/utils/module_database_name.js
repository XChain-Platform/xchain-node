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

// Identifier segment that scopes a derived database or DB user name to its NODE_PREFIX
// stack. The default prefix yields '' so existing deployments keep their names; any other
// prefix yields '<prefix>_' with every character outside [A-Za-z0-9] folded to '_' (the
// prefix may carry hyphens and dots, which a SQL identifier may not).
function nodePrefixSegment(nodePrefix, defaultPrefix, sep = '_') {
    if (nodePrefix === defaultPrefix) return ''
    return String(nodePrefix).replace(/[^A-Za-z0-9]/g, '_') + sep
}

module.exports = { DATABASE_NAME_KEY, configuredDatabaseName, nodePrefixSegment }
