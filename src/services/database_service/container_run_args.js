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

const { DB_MODULE_NAME } = require('../../config')
const { memoryArgsFor } = require('../memory_limit_service')
const { stopTimeoutArgs } = require('../stop_budget_service')

function createDatabaseContainerRunArgs(containerPrefix, logger) {
    const memory = memoryArgsFor(DB_MODULE_NAME)
    if (memory.note) logger.info(memory.note)
    return [
        'run', '-d', '--restart', 'unless-stopped', ...stopTimeoutArgs(DB_MODULE_NAME),
        '--name', containerPrefix, '--hostname', 'mariadb',
        '--log-opt', 'max-size=50m', '--log-opt', 'max-file=4', ...memory.args
    ]
}

module.exports = { createDatabaseContainerRunArgs }
