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
 * XChain Node - Telemetry Connector
 *
 * Sends anonymous usage pings to the platform's central hub. Modeled on
 * HubConnector: a single outbound HTTP call, short timeout, and fully
 * silent on failure: telemetry must never block or break a CLI command.
 ********************************************************************/

const axios = require('axios')

const DEFAULT_TELEMETRY_URL = 'https://hub.xchain.io/telemetry'

class TelemetryConnector {

    // url defaults to the central hub; XCHAIN_NODE_TELEMETRY_URL overrides it
    // (used in tests / self-hosted collectors).
    constructor(url) {
        this.url = url || process.env.XCHAIN_NODE_TELEMETRY_URL || DEFAULT_TELEMETRY_URL
    }

    // Fire one telemetry ping. Returns true on a 2xx, false on any error.
    // Never throws; the caller treats this as best-effort.
    async report(payload, timeout = 5000) {
        try {
            await axios.post(this.url, payload, { timeout })
            return true
        } catch (err) {
            // Offline, DNS failure, timeout, non-2xx: all swallowed.
            return false
        }
    }
}

module.exports = TelemetryConnector
module.exports.DEFAULT_TELEMETRY_URL = DEFAULT_TELEMETRY_URL
