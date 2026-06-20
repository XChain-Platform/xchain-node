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

    async ping(){
        const data = {
            jsonrpc: '2.0',
            method: 'ping',
            id: 1
        }
        
        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            console.error('ExplorerConnector: failed to check explorer connectivity:', err.message);
            return false
        }

        if (response.data && response.data.result) {
            return true;
        } else {
            return false
        }
    }
}

module.exports = ExplorerConnector