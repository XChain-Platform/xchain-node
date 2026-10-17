'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The bundled MariaDB's InnoDB buffer pool. The image default of 128 MB re-reads the
// per-chain schemas from disk on every block once they outgrow it, so the container
// starts with 1G unless XCHAIN_NODE_DB_BUFFER_POOL_SIZE names another size.
const DEFAULT_BUFFER_POOL_SIZE = '1G'

// A byte count with an optional K, M or G suffix, the forms mysqld accepts as a plain size.
const BUFFER_POOL_SIZE_PATTERN = /^\d+[KMG]?$/

// The size to pass as --innodb-buffer-pool-size: the operator's value when it matches
// BUFFER_POOL_SIZE_PATTERN, the default when it is unset, and the default with a warning
// when it is set but malformed, so a typo never keeps the container from starting.
function resolveBufferPoolSize(raw, warn) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_BUFFER_POOL_SIZE
    const value = String(raw).trim()
    if (BUFFER_POOL_SIZE_PATTERN.test(value)) return value
    warn('XCHAIN_NODE_DB_BUFFER_POOL_SIZE="' + value + '" is not a size such as 512M or 16G; using the default ' + DEFAULT_BUFFER_POOL_SIZE)
    return DEFAULT_BUFFER_POOL_SIZE
}

module.exports = { resolveBufferPoolSize, DEFAULT_BUFFER_POOL_SIZE, BUFFER_POOL_SIZE_PATTERN }
