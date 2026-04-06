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
var fs = require('fs')
var path = require('path')

const PREFIX_MODULE_CONTAINER = "MC"

class LevelUpStore {
    constructor(dbName, dbPath = "") {
        this.dbName = dbName
        this.db = null
        this.dbPath = dbPath
    }

    getFullPath() {
        return this.dbPath + "/" + this.dbName
    }

    _openDb() {
        return new Promise((resolve, reject) => {
            const db = levelup(leveldown(this.getFullPath()), (err) => {
                if (err) return reject(err)
                resolve(db)
            })
        })
    }

    async createDatabase() {
        try {
            this.db = await this._openDb()
            return this.db
        } catch (err) {
            if (err.message && err.message.includes('IO error') && err.message.includes('lock')) {
                return this._handleLockedDatabase()
            }
            throw new Error("Couldn't open/create levelup database: " + err.message)
        }
    }

    async _handleLockedDatabase() {
        const lockFile = path.join(this.getFullPath(), 'LOCK')
        console.log("\n⚠  The database appears to be locked.")
        console.log("   This usually happens when xchain-node didn't close properly.")
        console.log("   Lock file: " + lockFile + "\n")

        if (!process.stdin.isTTY) {
            throw new Error("Database is locked and running in non-interactive mode. Remove the lock file manually: " + lockFile)
        }

        const { Confirm } = require('enquirer')
        const prompt = new Confirm({
            name: 'unlock',
            message: 'Do you want to remove the lock and continue?'
        })

        const answer = await prompt.run().catch(() => false)

        if (!answer) {
            throw new Error("Database is locked. Please close any other xchain-node instance or remove the lock file manually.")
        }

        try {
            fs.unlinkSync(lockFile)
        } catch (unlinkErr) {
            throw new Error("Couldn't remove the lock file: " + unlinkErr.message)
        }

        try {
            console.log("   Lock removed. Reopening database...\n")
            this.db = await this._openDb()
            return this.db
        } catch (reopenErr) {
            throw new Error("Couldn't open database after removing lock: " + reopenErr.message)
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