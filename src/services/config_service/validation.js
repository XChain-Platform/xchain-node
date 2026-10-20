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
 * Config Service Validation
 ********************************************************************/

'use strict'

function validatePort(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 1 && value <= 65535
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const port = parseInt(value, 10)
        return port >= 1 && port <= 65535
    }
    return false
}

// Say whether a DB host names this machine's own loopback (localhost, 127.x, ::1, 0.0.0.0).
// Inside a bridge-networked container such a host is the container itself, not the docker host.
function isLoopbackHost(host) {
    const name = String(host == null ? '' : host).trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
    if (name === 'localhost' || name.endsWith('.localhost')) return true
    if (name === '::1' || name === '::' || name === '0.0.0.0') return true
    return /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

// Refuse a loopback external-DB host before it is handed to a service container.
function assertContainerReachableDbHost(host) {
    if (isLoopbackHost(host)) {
        throw new Error('External-DB host ' + String(host) + ' is a loopback address, which every service container '
            + 'resolves to itself. Set XCHAIN_NODE_EXTERNAL_DB_HOST to an address of the docker host that MariaDB '
            + 'listens on, usually the docker bridge gateway (for example 172.17.0.1).')
    }
}

module.exports = { validatePort, isLoopbackHost, assertContainerReachableDbHost }
