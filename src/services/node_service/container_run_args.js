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

const { NODE_MODULE_NAME } = require('../../config')
const { memoryArgsFor } = require('../memory_limit_service')

function createNodeContainerRunArgs(options) {
    const {
        coin, network, containerPrefix, stopBudgetSeconds, volumeMounts,
        getDockerNetwork, logger
    } = options
    const memory = memoryArgsFor(NODE_MODULE_NAME, { coin, network })
    if (memory.note) logger.info(memory.note)
    const runArgs = [
        'run', '-d', '--restart', 'unless-stopped', '--name', containerPrefix,
        '--stop-timeout', String(stopBudgetSeconds),
        '--log-opt', 'max-size=50m', '--log-opt', 'max-file=4',
        '--hostname', NODE_MODULE_NAME, '--network-alias', NODE_MODULE_NAME,
        '--ulimit', 'nofile=2048:2048', ...memory.args,
        '--network', getDockerNetwork(coin, network)
    ]
    for (const mount of volumeMounts) runArgs.push('-v', mount.spec)
    return runArgs
}

module.exports = { createNodeContainerRunArgs }
