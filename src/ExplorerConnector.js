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
 *
 * XChain Node - Explorer Connector Class
 * 
 ********************************************************************/

const axios = require('axios');

class ExplorerConnector {
    constructor(url, port) {
        this.url = "http://"+url+":"+port
        this.port = port
    }

    // Two independent facts about the explorer, which ping() collapses into one.
    //
    // `answering` means the HTTP server accepted the request and the JSON-RPC
    // handler replied AT ALL, a 503 included. `healthy` means that reply was a
    // success result, which the explorer only gives once it holds at least one
    // DB pool. The distinction exists because "up but holding no pools" is the
    // CORRECT state of an explorer on a host with no coin stack yet, and the
    // install path has to be able to tell it apart from a container that never
    // started. See installExplorerModule.
    async probe(){
        const data = {
            jsonrpc: '2.0',
            method: 'ping',
            id: 1
        }

        var response = null
        try {
            // Bounded timeout (matches HubConnector): without it, an explorer that
            // accepts the connection but never replies hangs the install/status
            // flow forever, since installExplorerModule awaits this ping.
            response = await axios.post(this.url, data, { timeout: 5000 })
        } catch (err) {
            // An HTTP status means the server answered and axios rejected on the
            // CODE; no status means nothing answered (refused, reset, timed out).
            if (err.response && err.response.status) {
                return { answering: true, healthy: false }
            }
            console.error('ExplorerConnector: failed to check explorer connectivity:', err.message);
            return { answering: false, healthy: false }
        }

        return {
            answering: true,
            healthy: !!(response.data && response.data.result)
        }
    }

    async ping(){
        return (await this.probe()).healthy
    }
}

module.exports = ExplorerConnector