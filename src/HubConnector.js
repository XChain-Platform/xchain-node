const axios = require('axios');

class HubConnector {
    constructor(url, port) {
        this.url = "http://"+url+":"+port
        this.port = port
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async ping(){
        const data = {
            jsonrpc: '2.0',
            method: 'ping',
            id: 1
        }
        
        // Make the request to the node
        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            return false
        }

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return true;
        } else {
            return false
        }
    }
    
    async updateConfig(newConfigJson){
        const data = {
            jsonrpc: '2.0',
            method: 'updateconfig',
            params: {config:newConfigJson},
            id: 1
        }
        
        // Make the request to the node
        const response = await axios.post(this.url, data)

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return true;
        } else {
            return false
        }
    }
}

module.exports = HubConnector