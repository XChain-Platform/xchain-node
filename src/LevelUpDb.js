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
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Node - LevelUpStore Class
 * 
 * This file handles reading and writing data to a LevelDB database
 *
 ********************************************************************/

// Load required libraries
var levelup = require('levelup')
var leveldown = require('leveldown')

const PREFIX_MODULE_CONTAINER = "MC"

class LevelUpStore {
    constructor(dbName, path = "") {
        this.dbName = dbName
        this.db = null
        this.path = path
    }
  
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
  
    async createDatabase() {
        try {
            this.db = levelup(leveldown(this.path+"/"+this.dbName)) 

            return this.db
        } catch (err){
            throw new Error("Couldn't open/create levelup database")
        }
    }

    async getAllModuleContainers(coin, network){
        return new Promise((resolve, reject) => {
            var modules = []
            const options = {
                gte: PREFIX_MODULE_CONTAINER,
                lte: PREFIX_MODULE_CONTAINER+"\xFF",
                keys: true,
                values: true
            }
          
            const stream = this.db.createReadStream(options);
          
            stream.on('data', function(data) {
                let dataString = data.key.toString("utf-8")
                
                dataString = dataString.substr(PREFIX_MODULE_CONTAINER.length) //Removing the prefix
                
                let dataArray = dataString.split(";")
                
                //Find its transaction and input(if it exists)
                if (dataArray.length == 3){
                    let module = dataArray[0]
                    let coinData = dataArray[1]
                    let networkData = dataArray[2]
                    
                    if (((coin == null) && (network == null))
                        || ((coin == coinData) && (network == networkData))
                        || ((coinData == "") && (networkData == ""))
                    ){
                        modules.push({
                            module: module,
                            network: networkData,
                            coin: coinData,
                            container_id: data.value.toString("utf-8")
                        })
                    }
                }
            })

            stream.on('error', function(err) {
                console.log("Error getting modules")
                console.log(err)
                reject(err)
            })

            stream.on('end', function() {
                resolve(modules)
            })
        })
    }

    moduleNetworkToKey(module, coin, network){
        return module+";"+coin+";"+network
    }

    async insertModuleContainer(module, coin, network, containerId){
        let key = PREFIX_MODULE_CONTAINER+this.moduleNetworkToKey(module,coin,network)
        let data = containerId
        
        try {
            let result = await this.db.put(key, data)
            return true
        } catch (err){
            //
        }
        return false
    }
  
    async getModuleContainer(module, coin, network){
        let key = PREFIX_MODULE_CONTAINER+this.moduleNetworkToKey(module,coin,network)
        
        try {
            let value = await this.db.get(key)
            
            if (value != null){
                return value.toString("utf-8")
            }
        } catch(err){
            //console.log(err)
        }
        
        return null
    }
    
    async removeModuleContainer(module, coin, network){
        let key = PREFIX_MODULE_CONTAINER+this.moduleNetworkToKey(module,coin,network)
        
        try {
            let value = await this.db.get(key)
            await this.db.del(key)
            if (value != null){
                return value.toString("utf-8")
            }
            return true
        } catch(err){
            console.log(err)
            return false
        }
        
        return null
    }
}

module.exports = LevelUpStore