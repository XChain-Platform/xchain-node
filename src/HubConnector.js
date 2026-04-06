/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
    }

    // Internal: call a JSON-RPC method, trying each endpoint in order
    async _call(data, timeout = 5000){
        for(let url of this.urls){
            try {
                let response = await axios.post(url, data, { timeout });
                if(response.data && response.data.result !== undefined)
                    return response.data.result;
            } catch(err){
                // Silent — try next endpoint
            }
        }
        return null;
    }

    async ping(){
        let result = await this._call({ jsonrpc: '2.0', method: 'ping', id: 1 });
        return result !== null;
    }

    async updateConfig(newConfigJson){
        let result = await this._call({
            jsonrpc: '2.0',
            method: 'updateconfig',
            params: { config: newConfigJson },
            id: 1
        }, 10000);
        return result !== null;
    }
}

module.exports = HubConnector
