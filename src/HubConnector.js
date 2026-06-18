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
 * XChain Node - Hub Connector Class
 *
 * Supports multi-endpoint fallback for high availability.
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');

class HubConnector {

    // Accept an array of endpoint URLs or a single host+port for backward compatibility
    constructor(endpoints, port) {
        if(Array.isArray(endpoints)){
            this.urls = endpoints;
        } else {
            this.urls = ["http://" + endpoints + ":" + port];
        }
        // Sticky-last-good endpoint: start each call at the last endpoint that
        // answered, so a degraded first endpoint isn't retried first every call
        // (which would cost the full timeout per call before falling back).
        this._lastGoodIdx = 0;
        // Per-endpoint failure detail from the most recent _call(). Populated with
        // "url → code|message" strings for each unreachable endpoint so callers
        // can report exactly what was tried and why, instead of a bare null.
        this.lastFailures = [];
    }

    // Internal: call a JSON-RPC method, trying each endpoint starting from the
    // last one that succeeded and wrapping around through the rest.
    async _call(data, timeout = 5000){
        // A reachable-but-unhealthy hub responds with a non-2xx status (e.g. the
        // 503 "degraded" health body returned when its DB pool is down) that
        // still carries a valid JSON-RPC body. Axios throws on any non-2xx, so
        // without inspecting err.response that state is indistinguishable from an
        // unreachable endpoint. Capture such a body as a fallback but keep trying
        // the remaining endpoints in case one is fully healthy.
        let degraded = null;
        this.lastFailures = [];
        for(let i = 0; i < this.urls.length; i++){
            let idx = (this._lastGoodIdx + i) % this.urls.length;
            let url = this.urls[idx];
            try {
                let response = await axios.post(url, data, { timeout });
                if(response.data && response.data.result !== undefined){
                    this._lastGoodIdx = idx;
                    return response.data.result;
                }
            } catch(err){
                if(err.response && err.response.data && err.response.data.result !== undefined){
                    degraded = err.response.data.result;
                } else {
                    // Unreachable. Record why so the caller can report which
                    // endpoints failed instead of an undiagnosable null.
                    this.lastFailures.push(url + ' → ' + (err.code || err.message));
                }
            }
        }
        // No endpoint returned a healthy result. Surface a reachable-but-degraded
        // response (if any) so callers can tell "up but DB down" from
        // "unreachable"; otherwise null, preserving the all-endpoints-failed signal.
        return degraded;
    }

    async ping(){
        let result = await this._call({ jsonrpc: '2.0', method: 'ping', id: 1 });
        // A reachable-but-degraded hub returns a non-null {status:"degraded"}
        // body. The hub is up, so report it as reachable rather than treating it
        // as down (which would make the install/restart loop exhaust its retries
        // against a live hub), but log the degraded state so it stays visible.
        if(result && typeof result === 'object' && result.status === 'degraded'){
            console.warn('Hub reachable but reporting degraded state: ', result);
        }
        return result !== null;
    }

    async updateConfig(newConfigJson){
        let result = await this._call({
            jsonrpc: '2.0',
            method: 'updateconfig',
            params: { config: newConfigJson },
            id: 1
        }, 60000);  // config pushes on multi-coin nodes can exceed a 10s ceiling (prod-validated on origin-host)
        return result !== null;
    }
}

module.exports = HubConnector
