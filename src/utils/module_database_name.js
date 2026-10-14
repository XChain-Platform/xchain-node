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

// MariaDB caps a database name at 64 characters and the indexer's mirror database adds
// '_HubMirror'. The longest unscoped name is 'XChain_DOGE_Testnet_Indexer' (27), so the
// scope segment (separator included) is capped to keep name plus mirror suffix inside 64.
const DB_NAME_MAX = 64
const HUB_MIRROR_SUFFIX = '_HubMirror'
const SCOPE_SEGMENT_MAX = 24

// Folds a NODE_PREFIX to its readable SQL-identifier segment: '' for the default prefix, else
// the prefix with characters outside [A-Za-z0-9] folded to '_' plus sep (a SQL identifier
// cannot carry hyphens or dots). Lossy and unbounded; derived names use scopedNodePrefixSegment.
function nodePrefixSegment(nodePrefix, defaultPrefix, sep = '_') {
    if (nodePrefix === defaultPrefix) return ''
    return String(nodePrefix).replace(/[^A-Za-z0-9]/g, '_') + sep
}

// The segment derived database and DB user names carry. Folding is lossy ('a-b' and 'a_b'
// collide) and long prefixes must be cut, so either case swaps the tail for a digest of the
// RAW prefix: distinct prefixes keep distinct names inside the length budget.
function scopedNodePrefixSegment(nodePrefix, defaultPrefix, sep = '_') {
    if (nodePrefix === defaultPrefix) return ''
    const raw = String(nodePrefix)
    const readable = nodePrefixSegment(raw, defaultPrefix, sep)
    if (readable.slice(0, -sep.length) === raw && readable.length <= SCOPE_SEGMENT_MAX) return readable
    const digest = require('crypto').createHash('sha256').update(raw).digest('hex').substring(0, 8)
    const head = readable.substring(0, SCOPE_SEGMENT_MAX - sep.length * 2 - digest.length)
    return head + sep + digest + sep
}

// The unprefixed default name a pre-scoping install (or the default stack) uses.
function unscopedDefaultDatabaseName(module, ticker, network, sep = '_') {
    const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1)
    return ['XChain', ticker, cap(network), cap(module.slice('xchain-'.length))].join(sep)
}

module.exports = {
    DATABASE_NAME_KEY, DB_NAME_MAX, HUB_MIRROR_SUFFIX, configuredDatabaseName, nodePrefixSegment,
    scopedNodePrefixSegment, unscopedDefaultDatabaseName
}
