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
 * XChain Node
 * 
 * This file handles setting up and managing an XChain Node
 *
 ********************************************************************/

// Load required libraries
const dotenv = require('dotenv')
dotenv.config()

const { exec } = require('child_process')
const { https } = require('follow-redirects');
const fs = require("fs");
const readline = require('readline')
const path = require("path")
const LevelUpStore = require('./LevelUpDb.js')
const GitHubDownloader = require('./GitHubDownloader.js')
const mariadb = require('mariadb')
const semver = require('semver')
const axios = require('axios')
const HubConnector = require('./HubConnector.js')

//Console interface
const { prompt, Select, Password } = require('enquirer');


const NODE_PREFIX = process.env.NODE_PREFIX
const DB_NAME = (process.env.DB_NAME == null?"xchain_node":process.env.DB_NAME)

const NODE_MODULE_NAME = "node"
const DB_MODULE_NAME = "database"
const HUB_MODULE_NAME = "xchain-hub"

const NODE_VERSION_FILE_NAME = "__VERSION__.txt"

const XChainModule = {
    XCHAIN_ENCODER: "xchain-encoder",
    XCHAIN_DECODER: "xchain-decoder",
    XCHAIN_UTXO_TRACKER: "xchain-utxo-tracker",
    XCHAIN_REGTEST_MINER: "xchain-regtest-miner",
    XCHAIN_INDEXER: "xchain-indexer",
    XCHAIN_E2E_TEST: "xchain-e2e-test"
}

const projectFolders = {
    "xchain-encoder":"XChainEncoder",
    "xchain-decoder":"XChainDecoder",
    "xchain-utxo-tracker": "XChainUtxoTracker",
    "xchain-regtest-miner": "XChainRegtestMiner",
    "xchain-indexer": "XChainIndexer",
    "xchain-hub": "XChainHub",
    "xchain-e2e-test": "XChainE2ETest"
}


const moduleDir = path.join(__dirname, "..", "modules")
const tmpDir = path.join(__dirname, "..", "tmp")
const srcDir = path.join(__dirname, "..", "src")
const cryptoNodesDir = path.join(__dirname,"..","crypto_nodes")
const dataDir = path.join(__dirname,"..","data")
const configDir = path.join(__dirname,"..","config")
const containersFilesDir = path.join(tmpDir, "containers_files")

const dbRootPasswords = {}


const nodeVersion = process.versions.node

var installedModules = {}

/*const modulesUrls = {
    "xchain-encoder": "https://github.com/XChain-platform/xchain-encoder",
    "xchain-decoder": "https://github.com/XChain-platform/xchain-decoder",
    "xchain-utxo-tracker": "https://github.com/XChain-platform/xchain-utxo-tracker",
    "xchain-indexer": "https://github.com/XChain-platform/xchain-indexer",
    "xchain-regtest-miner": "https://github.com/XChain-platform/xchain-regtest-miner",
    "xchain-hub": "https://github.com/XChain-platform/xchain-hub",
    "xchain-e2e-test": "https://github.com/XChain-platform/xchain-e2e-test"
}*/

var remoteModuleVersions = {}

const modulesUrls = {
    "xchain-encoder": "git@github.com:XChain-platform/xchain-encoder.git",
    "xchain-decoder": "git@github.com:XChain-platform/xchain-decoder.git",
    "xchain-utxo-tracker": "git@github.com:XChain-platform/xchain-utxo-tracker.git",
    "xchain-indexer": "git@github.com:XChain-platform/xchain-indexer.git",
    "xchain-regtest-miner": "git@github.com:XChain-platform/xchain-regtest-miner.git",
    "xchain-hub": "git@github.com:XChain-platform/xchain-hub.git",
    "xchain-e2e-test": "git@github.com:XChain-platform/xchain-e2e-test.git"
}

const Coin = {
    BITCOIN: "bitcoin",
    DOGECOIN: "dogecoin",
    LITECOIN: "litecoin"
}

const CoinTickerSymbol = {
    "bitcoin": "BTC",
    "dogecoin": "DOGE",
    "litecoin": "LTC"
}

const Network = {
    MAINNET: "mainnet",
    TESTNET: "testnet",
    REGTEST: "regtest"
}

const HUB_PORT = 10000

//Initializing db
const db = new LevelUpStore(DB_NAME, dataDir)
const gitHubDownloader = new GitHubDownloader(srcDir+"/github_hashes.json")

var statusUpdated = false
var lastStatus = null

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDirectories(){
    if (!fs.existsSync(dataDir)){
        fs.mkdirSync(dataDir)
    }
    if (!fs.existsSync(moduleDir)){
        fs.mkdirSync(moduleDir)
    }
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir)
    }
    if (!fs.existsSync(containersFilesDir)) {
        fs.mkdirSync(containersFilesDir)
    }
}

function stringToCoin(coinString) {
    for (let nextCoinIndex in Coin) {
        if (Coin[nextCoinIndex] == coinString) {
            return nextCoinIndex
        }
    }

    return null
}

function stringToXChainModule(moduleString){
    for (let nextXchainModuleIndex in XChainModule){
        if (XChainModule[nextXchainModuleIndex] == moduleString){
            return nextXchainModuleIndex
        }
    }
    
    return null
}

async function checkDockerInstalledAndReachable(){
    return new Promise((resolve, reject) => {
        exec('docker --version', (error, stdout, stderr) => {
            if (error){
                reject("Couldn't use the command docker --version")
            } else {
                let result = stdout.split(" ")
                
                if (result.length == 5){
                    let version = result[2]
                    
                    version = version.substr(0, version.length-2)
                    
                    //Now test if docker is reachable
                    exec('docker ps -a', (error, stdout, stderr) => {
                        if (error){
                            reject("Couldn't execute docker ps, is this user in the docker group")
                        } else {
                            resolve(true)
                        }
                    })
                } else {
                    reject("The format returned by docker --version is unknown")
                }
            }
        })
    })
}

async function checkAllRemoteVersions(){
    return Promise.all([
        getRemoteModuleVersion(XChainModule.XCHAIN_ENCODER),
        getRemoteModuleVersion(XChainModule.XCHAIN_DECODER),
        getRemoteModuleVersion(XChainModule.XCHAIN_UTXO_TRACKER),
        getRemoteModuleVersion(XChainModule.XCHAIN_REGTEST_MINER),
        getRemoteModuleVersion(XChainModule.XCHAIN_INDEXER)
    ])
}

async function getBootstrapFilesList(coin, network, module){
    return new Promise(async (resolve, reject)=>{
        let defaultConfig = await getDefaultConfig(module, coin, network)
        let fileList = []
            
        try {
            let directory = null
            
            switch(module){
                case XChainModule.XCHAIN_UTXO_TRACKER:
                    directory = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"];
                    break
                case XChainModule.XCHAIN_DECODER:
                    directory = defaultConfig["DECODER_BOOTSTRAP_VOLUME"];
                    break
            }
            
            let bootstrapFiles = await fs.promises.readdir(directory);
            
            for (const nextFileName of bootstrapFiles) {
                const filePath = path.join(directory, nextFileName);
                const stats = await fs.promises.stat(filePath);
                if (stats.isFile()) {
                    fileList.push(nextFileName)
                }
            }

            resolve(fileList)
        } catch (err) {
            console.log(err)
            reject(err)
        }
    })
}

async function waitForBootstrap(moduleUrl, taskId){
    return new Promise(async (resolve, reject) => {
        let lastProgress = -1
    
        while(true){
            const data = {
                jsonrpc: '2.0',
                method: 'getbootstrapstatus',
                params: {"taskid":taskId},
                id: 1
            }
        
            let response = null
            try{
                response = await axios.post(moduleUrl, data)
            } catch (err){
                console.log(err)
                throw new Error("There was an error trying to get the status of a bootstrap ("+taskId+")")
            }
            
            // Verify if there is a result and return it
            if (response.data.result) {
                let progress = response.data.result.progress
                
                if (progress != lastProgress){
                    console.log("Bootstrap progress..."+progress)
                    lastProgress = progress
                }
                
                if (progress >= 100){
                    resolve(true)
                }
            } else {
                reject("There was an error trying to get the status of a bootstrap")
                throw new Error('Error trying to get bootstrap status');
            }
        
        
            await sleep(5000) //Check status every 5 seconds
        }
    })
}

async function waitForBootstrapRestore(moduleUrl, taskId){
    return new Promise(async (resolve, reject) => {
        let lastProgress = -1
    
        while(true){
            const data = {
                jsonrpc: '2.0',
                method: 'getbootstraprestorestatus',
                params: {"taskid":taskId},
                id: 1
            }
        
            let response = null
            try{
                response = await axios.post(moduleUrl, data)
            } catch (err){
                console.log(err)
                throw new Error("There was an error trying to get the status of a bootstrap restore ("+taskId+")")
            }
            
            // Verify if there is a result and return it
            if (response.data.result) {
                let progress = response.data.result.progress
                
                if (progress != lastProgress){
                    console.log("Bootstrap restore progress..."+progress)
                    lastProgress = progress
                }
                
                if (progress >= 100){
                    resolve(true)
                }
            } else {
                reject("There was an error trying to get the status of a bootstrap restore")
                throw new Error('Error trying to get bootstrap restore status');
            }
            
            await sleep(5000) //Check status every 5 seconds
        }
    })
}

async function restoreBootstrap(coin, network, module, fileName){
    return new Promise(async (resolve, reject) => {
        let defaultConfig = await getDefaultConfig(module, coin, network)
        
        switch (module){
            case XChainModule.XCHAIN_UTXO_TRACKER:
                let port = defaultConfig["UTXO_TRACKER_PORT"]
                let moduleDockerVolume = defaultConfig["UTXO_TRACKER_DOCKER_VOLUME"]
                let moduleUrl = "http://localhost:"+port
                
                const data = {
                    jsonrpc: '2.0',
                    method: 'restorebootstrap',
                    params: {"filename":fileName},
                    id: 1
                }
                
                let response = null
                try{
                    response = await axios.post(moduleUrl, data)
                } catch (err){
                    reject(err)
                    return null
                }
                
                // Verify if there is a result and return it
                if (response.data.result.task_id) {
                    let bootstrapRestored = await waitForBootstrapRestore(moduleUrl, response.data.result.task_id)
                
                    if (bootstrapRestored){
                        resolve(true)
                    } else {
                        reject(false)
                    }
                } else {
                    throw new Error('Error trying to restore a bootstrap');
                }
                
                break
        }
    })
}

async function makeBootstrap(coin, network, module){
    return new Promise(async (resolve, reject) => {
        let defaultConfig = await getDefaultConfig(module, coin, network)
        
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const dateTimeString = `${year}${month}${day}_${hours}${minutes}${seconds}`;
                
        let fileName = network+"_"+module+"_"+dateTimeString
                
        
        switch (module){
            case XChainModule.XCHAIN_UTXO_TRACKER:
                let port = defaultConfig["UTXO_TRACKER_PORT"]
                let moduleDockerVolume = defaultConfig["UTXO_TRACKER_DOCKER_VOLUME"]
                let moduleUrl = "http://localhost:"+port
                
                const data = {
                    jsonrpc: '2.0',
                    method: 'getbootstrap',
                    params: {"filename":fileName},
                    id: 1
                }
                
                let response = null
                try{
                    response = await axios.post(moduleUrl, data)
                } catch (err){
                    reject(err)
                    return null
                }
                
                // Verify if there is a result and return it
                if (response.data.result.task_id) {
                    await waitForBootstrap(moduleUrl, response.data.result.task_id)
                
                    //Check if file exists
                    if (fs.existsSync(moduleDockerVolume+"/"+fileName)){
                        resolve(true)
                    } else {
                        reject(false)
                    }
                } else {
                    throw new Error('Error trying to make a bootstrap');
                }
                
                break
        }
    })  
}

async function getGithubProjectVersion(owner, repoName) {
    let githubRepoUrl = "https://api.github.com/repos/"+owner+"/"+repoName+"/releases/latest"

    let axiosResult = await axios.get(githubRepoUrl)
    let githubRepoReleasesJson = axiosResult.data

    let tagName = githubRepoReleasesJson["tag_name"]
    if (tagName.charAt(0) == 'v') {
        tagName = tagName.substring(1)
    }

    return { version: tagName, id: githubRepoReleasesJson["id"]}

}

async function checkRemoteNodeVersion(coin) {
    let githubProjectVersion = null
    switch (coin) {
        case Coin.BITCOIN:
            githubProjectVersion = await gitHubDownloader.getLatestCompatibleVersion("bitcoin", "bitcoin", true)
            //await getGithubProjectVersion("bitcoin", "bitcoin")
            break
        case Coin.DOGECOIN:
            githubProjectVersion = await gitHubDownloader.getLatestCompatibleVersion("dogecoin", "dogecoin", true)
            break
        case Coin.LITECOIN:
            githubProjectVersion = await gitHubDownloader.getLatestCompatibleVersion("litecoin-project", "litecoin", true)
            break
    }

    remoteModuleVersions["node_"+coin] = githubProjectVersion
}

async function getRemoteModuleVersion(module) {
    return new Promise(async (resolve, reject) => {
        await cloneGit(module, false, true)
        let packageJsonFilePath = getModuleTmpDir(module) + "/package.json"

        if (fs.existsSync(packageJsonFilePath)) {
            fs.readFile(packageJsonFilePath, 'utf8', (err, data) => {
                if (err) {
                    reject("There was a problem reading the package.json file of remote module " + module)
                    return;
                }
                try {
                    let packageJsonFile = JSON.parse(data)
                    remoteModuleVersions[module] = packageJsonFile["version"]
                    resolve(packageJsonFile["version"])
                } catch (error) {
                    reject("There was a problem parsing with json the package.json file of remote module " + module)
                }
            })
        } else {
            reject("There was a problem parsing with json the package.json file of remote module " + module + ": There is no file")
        }
    })
}

async function getContainerNodeVersion(coin, network, containerId) {
    return new Promise(async (resolve, reject) => {
        let versionFilePath = "/" + coin + "/" + NODE_VERSION_FILE_NAME

        try {
            let containerVersion = await getDockerContainerFileData(containerId, versionFilePath)
            resolve(containerVersion)
        } catch (err) {
            reject("There was an error trying to get the version file for the node " + coin + ":" + err)
        }
    })
}

async function getLocalNodeVersion(coin, network) {
    return new Promise(async (resolve, reject) => {
        let nodeVersionFile = getCryptoNodeDir(coin, network) + "/" + coin + "/" + NODE_VERSION_FILE_NAME
        if (fs.existsSync(nodeVersionFile)) {
            fs.readFile(nodeVersionFile, 'utf8', (err, data) => {
                if (err) {
                    reject("There was a problem reading version file of local crypto node " + coin + ":" + err)
                    return;
                }
                try {
                    resolve(data)
                } catch (error) {
                    reject("There was a problem reading version file of local crypto node " + coin + ":" + error)
                }
            })
        } else {
            reject("There was a problem reading version file of local crypto node " + coin + ": There is no file")
        }
    })
}

async function getLocalModuleVersion(module){
    return new Promise(async (resolve, reject) => {
        let packageJsonFilePath = getModuleDir(module) + "/package.json"
        if (fs.existsSync(packageJsonFilePath)) {
            fs.readFile(packageJsonFilePath, 'utf8', (err, data) => {
                if (err) {
                    reject("There was a problem reading the package.json file of local module " + module + ":" + err)
                    return;
                }
                try {
                    let packageJsonFile = JSON.parse(data)

                    if ("version" in packageJsonFile) {
                        resolve(packageJsonFile["version"])
                    } else {
                        reject("Couldn't find version info in the package.json file of local module "+module)
                    }
                } catch (error) {
                    reject("There was a problem parsing with json the package.json file of local module " + module +":" + error)
                }
            })
        } else {
            reject("There was a problem parsing with json the package.json file of local module " + module + ": There is no file")
        }
    })
}

async function getContainerModuleVersion(module, coin, network, containerId) {
    return new Promise(async (resolve, reject) => {
        let packageJsonFilePath = "/" + projectFolders[module] + "/package.json"

        //if (module == XChainModule.XCHAIN_INDEXER) {
        //  packageJsonFilePath = "/XChainIndexer/package.json"
        //}

        try {
            let containerVersion = await getDockerContainerFileData(containerId, packageJsonFilePath)
            let containerVersionJson = JSON.parse(containerVersion)
            resolve(containerVersionJson["version"])
        } catch (err) {
            reject("There was an error trying to get the package.json file from the module container "+module+" ("+coin+" "+network+"): "+err)
        }
    })
}


function checkIfModuleExists(module){
    let moduleDir = getModuleDir(module)
    
    result = fs.existsSync(moduleDir)
        && fs.existsSync(moduleDir+"/Dockerfile")
        && fs.existsSync(moduleDir+"/src")
        && fs.existsSync(moduleDir+"/package.json")
    
    return result
}

function checkIfCryptoNodeSourceExists(coin, network){
    let moduleDir = getCryptoNodeDir(coin, network)
    
    result = fs.existsSync(moduleDir)
        && fs.existsSync(moduleDir+"/Dockerfile")
        && fs.existsSync(moduleDir+"/src")
    
    return result
}

function stringToNetwork(networkString){
    let networkSplit = networkString.split("-")
    let coin = networkSplit[0]
    let network = networkSplit[1]
    
    let coinKey = null
    let networkKey = null
    
    for (key in Network){
        if (Network[key] == network){
            networkKey = key
            break
        }
    }
    
    for (key in Coin){
        if (Coin[key] == coin){
            coinKey = key
            break
        }
    }
    
    return {coin: coinKey, network: networkKey}
}

function getModuleDir(module){
    return moduleDir+"/"+module
}

function getModuleTmpDir(module) {
    return tmpDir + "/" + module
}

function getCryptoNodeDir(coin, network){
    if (!(coin in Coin)) {
        coin = stringToCoin(coin)
    }

    return cryptoNodesDir + "/" + Coin[coin]
}

function removeModuleDir(module){
    let moduleDir = getModuleDir(module)
    
    fs.rmSync(moduleDir, {recursive:true})
}

function removeModuleTmpDir(module) {
    let moduleTmpDir = getModuleTmpDir(module)

    if (fs.existsSync(moduleTmpDir)) {
        fs.rmSync(moduleTmpDir, { recursive: true })
    }
}

function createModuleTmpDir(module) {
    let moduleTmpDir = getModuleTmpDir(module)

    if (!fs.existsSync(moduleTmpDir)) {
        fs.mkdirSync(moduleTmpDir)
    }
}

function moduleDirExists(module){
    return fs.existsSync(getModuleDir(module))
}

function getDockerContainerImageNamePrefix(module, coin, network){
    if ((module == DB_MODULE_NAME) || (module == HUB_MODULE_NAME)){
        return NODE_PREFIX
    } else {
        return NODE_PREFIX + "_" + coin + "-" + network
    }
}

async function getDockerContainerFileData(containerId, filePath) {
    return new Promise((resolve, reject) => {
        exec('docker cp ' + containerId + ":" + filePath + " " + containersFilesDir, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                let data = fs.readFileSync(path.join(containersFilesDir, path.basename(filePath)), 'utf8');

                resolve(data)
            }
        })
    })
}

async function getDockerContainerFileCat(containerId, path) {
    return new Promise((resolve, reject) => {
        exec('docker exec -i ' + containerId+" cat "+path, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                resolve(stdout)
            }
        })
    })
}

function getDockerContainerImageName(module, coin, network){
    return getDockerContainerImageNamePrefix(module, coin, network) + "_" + module
}

async function getStatusFromContainer(containerId){
    return new Promise((resolve, reject) => {
        exec('docker inspect '+containerId, (error, stdout, stderr) => {
            if (error){
                reject(error)
            } else {
                resolve(JSON.parse(stdout)[0])
            }
        })
    })
}

async function getDockerNetworkInspect(dockerNetwork){
    return new Promise((resolve, reject) => {
        exec('docker network inspect '+dockerNetwork, (error, stdout, stderr) => {
            if (error){
                reject(error)
            } else {
                resolve(JSON.parse(stdout)[0])
            }
        })
    })
}


function getDockerNetwork(coin, network){
    return NODE_PREFIX+"_"+coin+"_"+network
}

async function createDockerNetwork(coin, network){
    return new Promise((resolve, reject) => {
        let network_name = getDockerNetwork(coin, network)
    
        //Check if network exists
        exec('docker network inspect '+network_name, (error, stdout, stderr) => {
            if (error){//It means the network doesn't exist
                exec('docker network create '+network_name, (error, stdout, stderr) => {
                    if (error){
                        console.log(error)
                        reject(false)
                    } else {
                        resolve(true)
                    }
                })
            } else {//This means the network already exists
                resolve(true)
            }
        })
    })
}

async function addContainerToNetwork(module, coin, network){
    return new Promise(async (resolve, reject) => {
        let moduleContainerId = await db.getModuleContainer(
            module, 
            (module == DB_MODULE_NAME?"":coin), 
            (module == DB_MODULE_NAME?"":network)
        )
        
        //Check if the module is connected to the network already
        let containerStatus = await getStatusFromContainer(moduleContainerId)
        
        if (!(getDockerNetwork(coin, network) in containerStatus["NetworkSettings"]["Networks"])){
            exec('docker network connect '+getDockerNetwork(coin, network)+' '+moduleContainerId+'', async (error, stdout, stderr) => {
                if (error){
                    reject(error)
                } else {
                    await statusChanged()
                    resolve(true)
                }
            })
        } else {
            resolve(true)
        }
    })
}

async function getAllContainerFromModule(module, coin, network){
    return new Promise((resolve, reject) => {
        let container_image_name = getDockerContainerImageName(module, coin, network)
    
        // --no-trunc to get the whole container id
        // -q to show only containers id and no other data
        // -a to show all containers, even exited ones
        // -f to filter by ancestor (image-name)
        
        exec('docker ps --no-trunc -q -a -f "ancestor='+container_image_name+'"', (error, stdout, stderr) => {
            resolve(true)
        })
    })
}

async function getDefaultConfig(module, coin, network){
    let defaultValues = null
    
    if (coin && network){
        defaultValues = {
            "NETWORK":network,
            "NODE_URL":NODE_MODULE_NAME,
            "NODE_PORT":(network==Network.MAINNET?8332:(network==Network.TESTNET?18332:18444)),
            "NODE_USER":"rpc",
            "NODE_PASSWORD":"rpc",
            "UTXO_TRACKER_URL":getDockerContainerImageName(XChainModule.XCHAIN_UTXO_TRACKER, coin, network),
            "UTXO_TRACKER_API_PORT":3001,
            "UTXO_TRACKER_PORT":3001,
            "UTXO_TRACKER_BOOTSTRAP_VOLUME":dataDir+"/"+coin+"/"+network+"/"+module+"/bootstrap/",
            "DECODER_DB_NAME":"xchain_decoder_"+coin+"_"+network,
            //"DECODER_DB_HOST":DB_MODULE_NAME,
            "DECODER_DB_HOST":"mariadb",
            "DECODER_DB_PORT":3306,
            "DECODER_DB_USER":"xchain_decoder_"+coin+"_"+network,
            "DECODER_DB_PASS":"xchain_password",
            "DECODER_URL":getDockerContainerImageName(XChainModule.XCHAIN_DECODER, coin, network),
            "DECODER_API_PORT":3002,
            "DECODER_PORT":3002,
            "DECODER_BOOTSTRAP_VOLUME":dataDir+"/"+coin+"/"+network+"/"+module+"/bootstrap/",
            "ENCODER_URL":getDockerContainerImageName(XChainModule.XCHAIN_ENCODER, coin, network),
            "ENCODER_API_PORT":3003,
            "ENCODER_PORT":3003,
            "INDEXER_HOST":getDockerContainerImageName(XChainModule.XCHAIN_INDEXER, coin, network),
            "INDEXER_API_PORT":3004,
            "INDEXER_PORT":3004,
            "INDEXER_COIN":CoinTickerSymbol[coin],
            "INDEXER_NETWORK":network,
            //"INDEXER_DB_HOST":DB_MODULE_NAME,
            "INDEXER_DB_HOST":"mariadb",
            "INDEXER_DB_PORT":3306,
            "INDEXER_DB_NAME":"xchain_indexer_"+coin+"_"+network,
            "INDEXER_DB_USER":"xchain_indexer_"+coin+"_"+network,
            "INDEXER_DB_PASS":"xchain_password",
            "HUB_HOST":"127.0.0.1",
            "HUB_PORT":10000
        }
        
        if (network == "regtest"){
            defaultValues["REGTEST_MINER_URL"] = getDockerContainerImageName(XChainModule.XCHAIN_REGTEST_MINER, coin, network)
            defaultValues["REGTEST_MINER_API_PORT"] = 3005,
            defaultValues["REGTEST_MINER_PORT"] = 3005
        }
        
    } else {
        defaultValues = {
            "HUB_HOST":"127.0.0.1",
            "HUB_PORT":10000
        }   
    }
    
    //Read the default config file
    let defaultConfig = {}
    if ((coin && network) && (coin != "") && (network != "")){
        const configFileStream = fs.createReadStream(configDir+"/"+coin+"-"+network)
        
        const rl = readline.createInterface({
            input: configFileStream,
            crlfDelay: Infinity
        })
        
        for await (const line of rl) {
            let lineSplit = line.split("=")
            
            if (lineSplit.length == 2){
                let key = lineSplit[0]
                let value = lineSplit[1]
                
                defaultConfig[key] = value
            }
        }
    }
    
    for (let nextKeyValue in defaultValues){
        if (!(nextKeyValue in defaultConfig)){
            defaultConfig[nextKeyValue] = defaultValues[nextKeyValue]
        }
    }
    
    return defaultConfig
}

async function buildCryptoNode(coin, network, bitcoinVer=null){
    return new Promise(async (resolve,reject)=>{
        let defaultConfig = await getDefaultConfig(NODE_MODULE_NAME, coin, network)
        let defaultExposedPort = defaultConfig["NODE_EXPOSED_PORT"]
        let defaultNodePort = defaultConfig["NODE_PORT"]
    
        let container_prefix = getDockerContainerImageName(NODE_MODULE_NAME, coin, network)
        let nodeDir = cryptoNodesDir+"/"+coin
    
        console.log("Building image of "+coin+" "+network+" node")
        exec('docker build . '
            +'--build-arg CONF_FILE='+coin+"-"+network+'.conf '
            +'-t '+container_prefix,
            {cwd:nodeDir}, (error, stdout, stderr) => 
        {
            if (error) {
                console.error(`Error creating Docker image: ${error.message}`);
                return;
            }
            
            // Create the container with docker up
            let dockerCommand = 
                'docker run -d '
                +'-v '+dataDir+"/"+NODE_MODULE_NAME+"/"+coin+"/"+network+":/.root/."+coin+" "
                +'--hostname '+NODE_MODULE_NAME+' '
                +'--network '+getDockerNetwork(coin, network)+' '
                + (defaultExposedPort && defaultNodePort ? '-p ' + defaultExposedPort + ':'+defaultNodePort+' ' : "")
                +' -e CRYPTO_NODE_VERSION='+bitcoinVer+' '
                +'-t '+container_prefix
            console.log("Creating container of "+coin+" "+network+" node")
            exec(dockerCommand, {cwd:nodeDir}, async (error, stdout, stderr) => {
                if (error) {
                    reject(`Error creating the container: ${error.message}`);
                }

                //If the response length has length 64, then it is most likely the container id
                let stdoutTrimmed = stdout.trim()
                if (stdoutTrimmed.length == 64){
                    let containerId = stdoutTrimmed
                    
                    if (await db.insertModuleContainer(NODE_MODULE_NAME, coin, network, containerId)){
                        await statusChanged()
                        resolve(containerId)
                    } else {
                        reject("There was a problem trying to store the container's id")
                    }
                }
            });
        });
    })
}


async function checkIfDatabaseIsReady(user, userPassword){
    return new Promise(async (resolve,reject)=>{
        let mariadbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
        let dockerCommand = 'docker exec -i '+mariadbContainerId+' mariadb -u '+user+' -p'+userPassword+' -e "SELECT 1"'
        let trying = false
        let isReady = false
        let tries = 3
        
        while (tries > 0){
            if (!trying){
                trying = true
                
                exec(dockerCommand, (error, stdout, stderr) => {
                    if (error){
                        //console.log(error)
                        tries = tries - 1
                        trying = false
                    } else {
                        isReady = true
                        tries = 0
                    }
                })
            }
            
            if (!isReady){
                await sleep(10000)
            }
        }

        if (isReady){
            resolve(true)
        } else { 
            resolve(false)
        }
    })
}

async function getInstalledCoinsAndNetworks(){
    let modulesStatus = await getStatus(null, null, false)
    let result = {}
    
    for (let nextCoin in modulesStatus){
        if (Object.values(Coin).includes(nextCoin)){
            result[nextCoin] = []
            
            for (let nextNetwork in modulesStatus[nextCoin]){
                if (Object.values(Network).includes(nextNetwork)){
                    result[nextCoin].push(nextNetwork)
                }
            }           
        }
    }
    
    return result
}


async function setDatabaseParameters(){
    return new Promise(async (resolve,reject)=>{
        let installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
        
        for (let nextCoin in installedCoinsAndNetworks){
            for (let nextNetworkIndex in installedCoinsAndNetworks[nextCoin]){
                let nextNetwork = installedCoinsAndNetworks[nextCoin][nextNetworkIndex]
                
                //Verify if mariadb container is in the docker network of this coin and network
                try {
                    await addContainerToNetwork(DB_MODULE_NAME, nextCoin, nextNetwork)
                    
                    let moduleContainerId = await db.getModuleContainer(XChainModule.XCHAIN_DECODER, nextCoin, nextNetwork)
                    if (moduleContainerId != null){
                        let defaultConfig = await getDefaultConfig(XChainModule.XCHAIN_DECODER, nextCoin, nextNetwork)                  
                        await addUserPasswordToDatabase(
                            XChainModule.XCHAIN_DECODER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["DECODER_DB_NAME"],
                            defaultConfig["DECODER_DB_USER"],
                            defaultConfig["DECODER_DB_PASS"]
                        )
                    }
                    moduleContainerId = await db.getModuleContainer(XChainModule.XCHAIN_INDEXER, nextCoin, nextNetwork)
                    if (moduleContainerId != null){
                        let defaultConfig = await getDefaultConfig(XChainModule.XCHAIN_INDEXER, nextCoin, nextNetwork)                  
                        await addUserPasswordToDatabase(
                            XChainModule.XCHAIN_INDEXER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["INDEXER_DB_NAME"],
                            defaultConfig["INDEXER_DB_USER"],
                            defaultConfig["INDEXER_DB_PASS"]
                        )
                        await addUserPasswordToDatabase(
                            XChainModule.XCHAIN_INDEXER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["DECODER_DB_NAME"],
                            defaultConfig["DECODER_DB_USER"],
                            defaultConfig["DECODER_DB_PASS"]
                        )
                    }
                } catch(err) {
                    console.log(err)
                    console.log("There was a problem adding de database container to the docker network of "+nextCoin+" "+nextNetwork+"")
                    reject(err)
                }
            }
        }
        
        resolve(true)
    })
}

async function executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, command, commandOptions = ""){
    return new Promise(async (resolve,reject)=>{
        let dockerCommand = 'docker exec -i '+mariadbContainerId+' mariadb -u root -p'+mariadbRootPassword+' -e "'+command+'"'
        
        
        if (commandOptions != ""){
            dockerCommand = dockerCommand + " " + commandOptions
        }
        
        exec(dockerCommand, (error, stdout, stderr) => {
            if (error){
                reject(error)
            } else {
                resolve(stdout.trim())
            }
        })
    })  
}

async function addUserPasswordToDatabase(module, coin, network, databaseName, user, userPassword, inDocker = true){
    return new Promise(async (resolve,reject)=>{
        if (!(coin in dbRootPasswords)){
            await askMariadbRootPassword(coin, network)
        }
        let mariadbRootPassword = dbRootPasswords[coin]//[network]
        
        let moduleContainerId = await db.getModuleContainer(module, coin, network)
        let containerStatus = await getStatusFromContainer(moduleContainerId)
        let dockerNetwork = getDockerNetwork(coin, network)
        let docketNetworkInspect = await getDockerNetworkInspect(dockerNetwork)
        
        let gatewayIp = docketNetworkInspect["IPAM"]["Config"][0]["Gateway"]
        let gatewayIpSplit = gatewayIp.split(".")
        gatewayIp = gatewayIpSplit[0]+"."+gatewayIpSplit[1]+".0.0"
        
        let host = gatewayIp+"/255.255.255.0"
        let mariadbUser = "'"+user+"'@'"+host+"'"
        
        //This means mariadb is inside a docker container, we will execute the queries using docker command
        if (inDocker){
            try {
                await checkIfDatabaseIsReady("root", mariadbRootPassword)
            
        
                let mariadbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
                
                let databaseCount = await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "SELECT COUNT(SCHEMA_NAME) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '"+databaseName+"'", "-B -N"
                )
                if (databaseCount == 0){
                    await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                        "CREATE DATABASE IF NOT EXISTS "+databaseName+""
                    )   
                    console.log("Database "+databaseName+" created!")
                }
                
                let userCount = await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "SELECT COUNT(*) FROM mysql.user WHERE user = '"+user+"' AND host = '"+host+"' AND password = PASSWORD('"+userPassword+"')", "-B -N"
                )
                if (userCount == 0){
                    await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                        "CREATE USER IF NOT EXISTS "+mariadbUser+" IDENTIFIED BY '"+userPassword+"'"
                    )
                    console.log("User "+mariadbUser+" created!")
                }
                
                let userGrants = await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                    "SHOW GRANTS FOR "+mariadbUser+"", "-B -N"
                )   
                userGrants = userGrants.replace("`","'")
                userGrants = userGrants.split("\n")
                if (!userGrants.includes(mariadbContainerId, mariadbRootPassword,
                    "GRANT ALL PRIVILEGES ON '"+databaseName+"'.* TO "+mariadbUser
                )){
                    await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                        "GRANT ALL PRIVILEGES ON "+databaseName+".* TO "+mariadbUser
                    )   
                    await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
                        "FLUSH PRIVILEGES"
                    )   
                    console.log("Permissions granted to "+mariadbUser+"!")
                }

                resolve(true)
            } catch(err) {
                console.log(err)
                reject(err)
                return
            }
        //This means mariadb was not installed by this xchain-node, we will use the root password to add our user
        } else {
            //TODO: add user, create database and grant privileges to a remote mariadb
        }
    })
}

async function checkIfDatabaseModuleExists(coin, network){
    return new Promise(async (resolve,reject)=>{
        let defaultConfig = await getDefaultConfig(DB_MODULE_NAME, coin, network)
        
        if (
            (("DB_URL" in defaultConfig) && (defaultConfig["DB_URL"] != "mariadb"))
            && ("DB_PORT" in defaultConfig)
            && ("DECODER_DB_USER" in defaultConfig)
            && ("DB_PASSWORD" in defaultConfig)
        ){
            let connectionParams = {
                host: defaultConfig["DB_URL"],
                port: defaultConfig["DB_PORT"],
                user: defaultConfig["DECODER_DB_USER"],
                password: defaultConfig["DB_PASSWORD"]
            }
                
            let tries = 3
            let connected = false
            
            while (tries > 0){
                try {
                    let connection = await mariadb.createConnection(connectionParams)
                    connected = true
                    break
                } catch(err){
                    if ("code" in err){
                        if (err["code"] == 'ECONNREFUSED'){
                            //Couldn't reach the server, could be temporary, let's try again
                            tries = tries - 1
                            //Let's try some more
                            await sleep(1000) //Waiting one second  
                        } else if (err["code"] == 'ER_ACCESS_DENIED_ERROR'){
                            console.log("The user doesn't exist in the database")
                            
                            //Mariadb server seems installed, let the user configure the access
                        } else {
                            //console.log(err)
                            break
                        }
                    } 
                }
            }
                
            if (connected){
                resolve(true)
            } else {
                reject("Couldn't connect")
                
                //The connection failed, it means the database doesn't exist or is down.
                //Let's check first if there's a docker container with a database installed by this xchain-node
                //await getAllContainerFromModule(DB_MODULE_NAME, coin, network)
            }
            
        } else {
            //Because there are no parameters to connect to a remote database. Then the database must be on a docker container
        
            try {
                let dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
                
                let containerStatus = await getStatusFromContainer(dbContainerId)
                
                if (("State" in containerStatus) && ("Status" in containerStatus["State"])){
                    resolve(true)
                } else {
                    resolve(false)
                }
            } catch (err) {
                resolve(false)
            }
            //reject("Some database config values are missing. Check that the config has DB_URL, DB_PORT, DECODER_DB_USER and DB_PASSWORD and try again.")
        }
    })
}

async function checkIfHubModuleExists(){
    return new Promise(async (resolve,reject)=>{
        let defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
        
        if (
            ("HUB_HOST" in defaultConfig)
            && ("HUB_PORT" in defaultConfig)
        ){
            let tries = 3
            let connected = false
            
            while (tries > 0){
                try {
                    let connection = await mariadb.createConnection(connectionParams)
                    connected = true
                    break
                } catch(err){
                    if ("code" in err){
                        if (err["code"] == 'ECONNREFUSED'){
                            //Couldn't reach the server, could be temporary, let's try again
                            tries = tries - 1
                            //Let's try some more
                            await sleep(1000) //Waiting one second  
                        } else if (err["code"] == 'ER_ACCESS_DENIED_ERROR'){
                            console.log("The user doesn't exist in the database")
                            
                            //Mariadb server seems installed, let the user configure the access
                        } else {
                            //console.log(err)
                            break
                        }
                    } 
                }
            }
                
            if (connected){
                resolve(true)
            } else {
                reject("Couldn't connect")
                
                //The connection failed, it means the database doesn't exist or is down.
                //Let's check first if there's a docker container with a database installed by this xchain-node
                //await getAllContainerFromModule(DB_MODULE_NAME, coin, network)
            }
            
        } else {
            //Because there are no parameters to connect to a remote database. Then the database must be on a docker container
        
            try {
                let dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
                
                let containerStatus = await getStatusFromContainer(dbContainerId)
                
                if (("State" in containerStatus) && ("Status" in containerStatus["State"])){
                    resolve(true)
                } else {
                    resolve(false)
                }
            } catch (err) {
                resolve(false)
            }
            //reject("Some database config values are missing. Check that the config has DB_URL, DB_PORT, DECODER_DB_USER and DB_PASSWORD and try again.")
        }
    })
}

async function askMariadbRootPassword(coin, network){
    return new Promise(async (resolve,reject)=>{
        let prompt = new Password({
            name: 'password',
            message: 'The password for the root user of mariadb is needed in order to create the database container and/or adding new users. What password do you want to set?'
        })
        
        prompt.run().then(
            async(answer) => {
                /*if (!(coin in dbRootPasswords)){
                    dbRootPasswords[coin] = {}
                }*/
                
                //dbRootPasswords[coin][network] = answer
                dbRootPasswords[coin] = answer
                
                resolve(answer)
            }
        ).catch(
            async()=>{
                console.log("An error has ocurred")
                reject(console.error)
            }
        )
    })
    
}

async function buildDatabaseModule(coin, network){
    return new Promise(async (resolve,reject)=>{
        if (!(await checkIfDatabaseModuleExists(coin, network))){
            //The mariadb container is about to be created, so first the user will be asked for the root password for mariadb
            let mariadbRootPassword = await askMariadbRootPassword(coin, network)
            
            //Creating the environmentVariables for this specific module
            let environmentVariables = await getDefaultConfig(DB_MODULE_NAME, coin, network)
            
            //let moduleDir = getModuleDir(module)
            //let dockerComposeFilePath = moduleDir + "/docker-compose.yml"
            let container_prefix = getDockerContainerImageName(DB_MODULE_NAME, coin, network)
    
            console.log("Building image of database")
            let portLine = ""
            if ("DB_PORT" in environmentVariables){
                portLine = "-p "+environmentVariables["DB_PORT"]+":3306"
            }
            
            let networkLine = ""
            if ((coin != "") && (network != "")){
                networkLine = '--network '+getDockerNetwork(coin, network)
            }
            
            //Download the latest mariadb from the hub
            exec('docker pull mariadb:latest ', (error, stdout, stderr) => {
                //Put a new name on the downloaded image
                exec('docker tag mariadb:latest '+container_prefix, (error, stdout, stderr) => {
                    // Create the container with docker up
                    let dockerCommand = 'docker run -d --hostname mariadb '+networkLine+' '+portLine+' --env MYSQL_ROOT_PASSWORD='+mariadbRootPassword+' '+container_prefix
                    console.log("Creating container of module "+DB_MODULE_NAME)
                    exec(dockerCommand, async (error, stdout, stderr) => {
                        if (error) {
                            reject(`Error creating the container: ${error.message}`);
                        }

                        //If the response length has length 64, then it is most likely the container id
                        let stdoutTrimmed = stdout.trim()
                        if (stdoutTrimmed.length == 64){
                            let containerId = stdoutTrimmed
                            
                            //There will be only a single mariadb container for all coins
                            if (await db.insertModuleContainer(DB_MODULE_NAME, "", "", containerId)){
                                await statusChanged()
                                resolve(containerId)
                            } else {
                                reject("There was a problem trying to store the container's id")
                            }
                        }
                    });
                })
            })
        } else {
            try{
                await addContainerToNetwork(DB_MODULE_NAME, coin, network)
                await statusChanged()
                resolve(true)
            } catch (err){
                console.log(err)
                reject("There was a problem trying to add the db container to the network "+coin+" "+network)
            }
            
        }
    })
}

async function buildAndUp(module, coin, network, overwrite_container_id=null, onlyExecution=false){
    return new Promise(async (resolve,reject)=>{
        if (checkIfModuleExists(module)){
        
            //Creating the environmentVariables for this specific module
            let environmentVariablesLine = ""
            let environmentVariables = await getDefaultConfig(module, coin, network)
            
            for (let nextEnvironmentVariableKey in environmentVariables){
                let nextEnvironmentVariableValue = environmentVariables[nextEnvironmentVariableKey]
                    
                environmentVariablesLine = environmentVariablesLine + ' -e "'+nextEnvironmentVariableKey+'='+nextEnvironmentVariableValue+'"'
            }
            
            let moduleDir = getModuleDir(module)
            let container_prefix = getDockerContainerImageName(module, coin, network)// NODE_PREFIX + "_" + coin + "-" + network
    
            console.log("Building image of module "+module+(coin && network?" in "+coin+" "+network:""))
            exec('docker build . -t '+container_prefix, {cwd:moduleDir}, async (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error creating Docker image: ${error.message}`);
                    return;
                }
                
                let portLine = ""
                let volumeLine = ""
                switch(module){
                    case XChainModule.XCHAIN_DECODER:
                        if (("DECODER_PORT" in environmentVariables) && ("DECODER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["DECODER_PORT"]+":"+environmentVariables["DECODER_API_PORT"]
                        }
                        volumeLine = 
                            "-v "+environmentVariables["DECODER_BOOTSTRAP_VOLUME"]+":/bootstrap/xchain-decoder "
                        break
                    case XChainModule.XCHAIN_ENCODER:
                        if (("ENCODER_PORT" in environmentVariables) && ("ENCODER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["ENCODER_PORT"]+":"+environmentVariables["ENCODER_API_PORT"]
                        }
                        break
                    case XChainModule.XCHAIN_UTXO_TRACKER:
                        if (("UTXO_TRACKER_PORT" in environmentVariables) && ("UTXO_TRACKER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["UTXO_TRACKER_PORT"]+":"+environmentVariables["UTXO_TRACKER_API_PORT"]
                        }
                        
                        volumeLine = 
                            "-v "+module+"_"+coin+"-"+network+"-data:/data/xchain-utxo-tracker "
                            +"-v "+environmentVariables["UTXO_TRACKER_BOOTSTRAP_VOLUME"]+":/bootstrap/xchain-utxo-tracker "
                        
                        break
                    case XChainModule.XCHAIN_INDEXER:
                        if (("INDEXER_PORT" in environmentVariables) && ("INDEXER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["INDEXER_PORT"]+":"+environmentVariables["INDEXER_API_PORT"]
                        }
                        break
                    case XChainModule.XCHAIN_REGTEST_MINER:
                        if ("REGTEST_MINER_PORT" in environmentVariables){
                            portLine = "-p "+environmentVariables["REGTEST_MINER_PORT"]+":"+environmentVariables["REGTEST_MINER_API_PORT"]
                        }
                        break
                    case HUB_MODULE_NAME:
                        coin = ""
                        network = ""
                        portLine = "-p "+environmentVariables["HUB_PORT"]+":3000"
                        break   
                }       

                if (overwrite_container_id) {
                    try {
                        await killContainer(overwrite_container_id)
                    } catch {
                        //This try..catch prevents an error if the container is not running
                    }
                    await removeContainer(overwrite_container_id)
                }


                // Create the container with docker up
                let dockerCommand = 'docker run '
                    +'-d --hostname '+container_prefix+' '
                    +volumeLine
                    +(coin && network?'--network '+getDockerNetwork(coin, network)+' ':"")
                    +environmentVariablesLine+' '
                    +portLine+' '
                    +'-t '+container_prefix
                console.log("Creating container of module "+module+(coin && network?" in "+coin+" "+network:""))
                exec(dockerCommand, {cwd:moduleDir}, async (error, stdout, stderr) => {
                    if (error) {
                        reject(`Error creating the container: ${error.message}`);
                    }

                    //If the response length has length 64, then it is most likely the container id
                    let stdoutTrimmed = stdout.trim()
                    if (stdoutTrimmed.length == 64){
                        let containerId = stdoutTrimmed
                        
                        if (!onlyExecution){
                            if (await db.insertModuleContainer(module, coin, network, containerId)){
                                await statusChanged()
                                resolve(containerId)
                            } else {
                                reject("There was a problem trying to store the container's id")
                            }
                        } else {
                            resolve(containerId)
                        }
                    }
                });
            });
        } else {
            reject("module not found")
        }
    })
}

async function cloneGit(module, rewrite = false, useTmp = false){
    return new Promise((resolve,reject)=>{
        if (useTmp) {
            removeModuleTmpDir(module)
            createModuleTmpDir(module)
        } else {
            if (moduleDirExists(module)) {
                if (rewrite) {
                    removeModuleDir(module)
                } else {
                    reject("Module directory already exists")
                }
            }
        }
        
        if (module in modulesUrls){
            let gitUrl = modulesUrls[module]

            let destination = ""

            if (useTmp) {
                destination = getModuleTmpDir(module)
            } else {
                destination = getModuleDir(module)
            }

            exec(`git clone ${gitUrl} ${destination}`, (error, stdout, stderr) => {
                if (error) {
                    reject(`Error cloning project: ${error.message}`)
                } else {
                    resolve(true)
                }
            })
        } else {
            reject("module doesn't have a url")
        }
    })
}

async function decompressTarGz(file){
    return new Promise((resolve,reject)=>{
        exec('tar -xvzf '+file, {cwd:path.dirname(file)}, (error, stdout, stderr) => {
            if (error) {
                reject(`Error decompressing a file: ${error.message}`)
            } else {
                resolve(true)
            }
        })
    })
}

async function getCryptoNode(coin, network, version){
    return new Promise(async (resolve,reject)=>{
        if (coin == Coin.BITCOIN){
            console.log("Downloading bitcoin node...")
            const destination = cryptoNodesDir+"/bitcoin"
            const filePath = destination+"/bitcoin"+version+".tar.gz"
            
            //Download bitcoin core
            const bitcoinNodeFile = fs.createWriteStream(filePath)
            const downloadUrl = "https://bitcoincore.org/bin/bitcoin-core-"+version+"/bitcoin-"+version+"-x86_64-linux-gnu.tar.gz"
            const request = https.get(downloadUrl, function(response) {
                response.pipe(bitcoinNodeFile)

                bitcoinNodeFile.on("error", async() => {
                    console.log("An error happened while trying to download the bitcoin node")
                })
    
                //After download completed close filestream
                bitcoinNodeFile.on("finish", async() => {
                    bitcoinNodeFile.close()
                   
                    try {
                        console.log("Decompressing bitcoin node files...")
                        await decompressTarGz(filePath)
                        
                        if (fs.existsSync(destination+"/bitcoin")){
                            if (semver.gte(nodeVersion,"14.14.0")){
                                fs.rmSync(destination+"/bitcoin", {recursive: true, force: true})   
                            } else {
                                fs.rmdirSync(destination+"/bitcoin", {recursive: true})
                            }
                        }
                        
                        /*if (semver.gte(nodeVersion,"14.14.0")){
                            fs.cpSync(destination+"/bitcoin-"+version,destination+"/bitcoin", {recursive:true})
                        } else {
                            fs.copyFileSync(destination+"/bitcoin-"+version,destination+"/bitcoin")
                        }*/
                        
                        fs.renameSync(destination + "/bitcoin-" + version, destination + "/bitcoin")
                        fs.writeFileSync(destination + "/bitcoin/" + NODE_VERSION_FILE_NAME, version)
                    } catch (err) {
                        reject(err)
                    }
                    
                    resolve(true)
                })
            })
        } else if (coin == Coin.DOGECOIN) {
            await gitHubDownloader.downloadRepoVersion("dogecoin", "dogecoin", version, {outputPath:cryptoNodesDir+"/dogecoin"})
        } else if (coin == Coin.LITECOIN) {
            await gitHubDownloader.downloadRepoVersion("litecoin-project", "litecoin", version, {outputPath:cryptoNodesDir+"/litecoin"})
        } else {
            reject("There's no support for "+coin+" in "+network+" network yet")
        }
    })
}

async function statusChanged(){
    statusUpdated = false
    await updateHub()
}

async function getStatus(coin, network, printStatus = false){
    return new Promise(async (resolve, reject) => {
        if (statusUpdated){
            resolve(lastStatus)
        } else {
            await loadInstalledModules(coin, network)
            
            let coins = Object.keys(installedModules)
            
            if (coins.length > 0){
                //if (printStatus){console.log("Modules installed:")}
                
                for (let nextCoin in installedModules) {
                    if (!((NODE_MODULE_NAME + "_" + nextCoin) in remoteModuleVersions)) {
                        await checkRemoteNodeVersion(nextCoin)
                    }

                    let nextCoinNetworks = installedModules[nextCoin]
                    
                    for (let nextCoinNetwork in nextCoinNetworks){
                        let nextCoinNetworkModules = installedModules[nextCoin][nextCoinNetwork]
                        let nextCoinNetworkModulesKeys = Object.keys(nextCoinNetworkModules)
                        
                        let titlePrinted = false
                        if (nextCoinNetworkModulesKeys.length > 0){
                            let coinNetworkModulesForElimination = []
                        
                            for (let nextCoinNetworkModule in nextCoinNetworkModules){
                                let containerId = nextCoinNetworkModules[nextCoinNetworkModule]["container_id"]
                                
                                try {
                                    let containerStatus = await getStatusFromContainer(containerId)
                
                                    nextCoinNetworkModules[nextCoinNetworkModule]["status"] = containerStatus
                
                                    if (!titlePrinted){
                                        if (printStatus){console.log("\x1b[37m["+(nextCoin+" - "+nextCoinNetwork).toUpperCase()+"]\x1b[37m")}
                                        titlePrinted = true
                                    }
                
                                    if (printStatus) {
                                        let moduleRemoteVersion = "-"
                                        try {
                                            if (nextCoinNetworkModule == NODE_MODULE_NAME) {
                                                moduleRemoteVersion = remoteModuleVersions[nextCoinNetworkModule + "_" + nextCoin]["tag_name"].substring(1)
                                            } else {
                                                moduleRemoteVersion = remoteModuleVersions[nextCoinNetworkModule]
                                            }
                                        } catch (e) {
                                            //Nothing yet
                                        }
                                        let moduleLocalVersion = "-"
                                        try {
                                            if (nextCoinNetworkModule == NODE_MODULE_NAME) {
                                                moduleLocalVersion = await getLocalNodeVersion(nextCoin, nextCoinNetwork)
                                            } else {
                                                moduleLocalVersion = await getLocalModuleVersion(nextCoinNetworkModule)
                                            }
                                        } catch (e) {
                                            //Nothing yet
                                        }
                                        let moduleContainerVersion = "-"
                                        try {
                                            if (nextCoinNetworkModule == NODE_MODULE_NAME) {
                                                moduleContainerVersion = await getContainerNodeVersion(nextCoin, nextCoinNetwork, containerId)
                                            } else {
                                                moduleContainerVersion = await getContainerModuleVersion(nextCoinNetworkModule, nextCoin, nextCoinNetwork, containerId)
                                            }
                                        } catch (e) {
                                            //Nothing yet
                                        }
                                        let versionString = " {remote:" + moduleRemoteVersion + ", local:" + moduleLocalVersion + ", container:" + moduleContainerVersion+"}"


                                        if (containerStatus["State"]["Status"] == "Exited") {
                                            console.log(" \x1b[31m" + nextCoinNetworkModule + " (" + containerStatus["State"]["Status"] + ")\x1b[37m " + versionString + "")
                                        } else {
                                            console.log(" \x1b[32m" + nextCoinNetworkModule + " (" + containerStatus["State"]["Status"] + ")\x1b[37m " + versionString + "")
                                        }
                                    }
                                } catch(err){
                                    //console.log("Error inspecting the container. ")
                                    //console.log(err)
                                    //TODO: add the module to a list for elimination or indicate that the module is missing
                                    
                                    
                                    //console.log("There was an error inspecting the container")
                                    coinNetworkModulesForElimination.push(nextCoinNetworkModule)
                                    
                                }
                            }
                            
                            //Delete all modules with status problem (they don't exist anymore as docker containers)
                            for (let nextEliminationIndex in coinNetworkModulesForElimination){
                                let nextElimination = coinNetworkModulesForElimination[nextEliminationIndex]
                                
                                delete nextCoinNetworkModules[nextElimination]
                            }
                        }
                        
                        if (Object.keys(nextCoinNetworkModules).length == 0){
                            if ((nextCoinNetwork == null) && (nextCoinNetwork == null)){
                                delete installedModules[null][null]
                            } else if ((nextCoinNetwork == "null") || (nextCoinNetwork == "null")){
                                if (("null" in installedModules) && ("null" in installedModules["null"])){
                                    delete installedModules["null"]["null"]
                                }
                            } else if ((nextCoinNetwork == null) || (nextCoinNetwork == undefined)){
                                delete installedModules[nextCoin][undefined]
                            } else {
                                delete installedModules[nextCoin][nextCoinNetwork]
                            }
                        }
                    }
                    
                    if (Object.keys(nextCoinNetworks).length == 0){
                        delete installedModules[nextCoin]
                    } 
                }
                
                if (printStatus){console.log("")}
            }
            
            lastStatus = installedModules
            statusUpdated = true
            
            resolve(installedModules)
        }
    })
}

async function loadInstalledModules(coin, network) {
    await checkRemoteNodeVersion(coin, network)
    let modules = await db.getAllModuleContainers(coin, network)
    
    for (let nextModuleIndex in modules){
        let nextModule = modules[nextModuleIndex]
        
        let module = nextModule["module"]
        let coin = nextModule["coin"]
        let network = nextModule["network"]
        let containerId = nextModule["container_id"]
        
        if (!(coin in installedModules)){
            installedModules[coin] = {}
        }
        
        if (!(network in installedModules[coin])){
            installedModules[coin][network] = {}
        }
        
        if (!(module in installedModules[coin][network])){
            installedModules[coin][network][module] = {}
        }
        
        installedModules[coin][network][module]["container_id"] = containerId
    }
}

async function restartContainer(containerId){
    return new Promise(async (resolve, reject) => {
        exec('docker restart '+containerId, async (error, stdout, stderr) => {
            if (error){
                reject(error)
            } else {
                let response = stdout.trim()
                
                if (response == containerId){
                    await statusChanged()
                    resolve(true)
                } else {
                    reject("There was an error trying to restart a docker container")
                }
            }
        })
    })
}

async function removeContainer(containerId){
    return new Promise(async (resolve, reject) => {
        exec('docker rm '+containerId, async (error, stdout, stderr) => {
            if (error){
                reject(error)
            } else {
                let response = stdout.trim()
                
                if (response == containerId){
                    await statusChanged()
                    resolve(true)
                } else {
                    reject("There was an error trying to remove a docker container")
                }
            }
        })
    })
}

async function killContainer(containerId){
    return new Promise(async (resolve, reject) => {
        exec('docker kill '+containerId, async (error, stdout, stderr) => {
            if (error){
                reject(error)
            } else {
                let response = stdout.trim()
                
                if (response == containerId){
                    await statusChanged()
                    resolve(true)
                } else {
                    reject("There was an error trying to kill a docker container")
                }
            }
        })
    })
}

async function installModule(coin, network, module, remoteUpdate=false, overwrite_container_id=null, onlyExecution=false){
    return new Promise(async (resolve, reject) => {
        if (module == NODE_MODULE_NAME) {
            let localNodeVersion = null
            try {
                localNodeVersion = await getLocalNodeVersion(coin, network)
            } catch (err) {
                //Nothing localNodeVersion will be null
            }

            if (localNodeVersion == null) {
                try {
                    let remoteNodeVersion = remoteModuleVersions[NODE_MODULE_NAME + "_" + coin]["version"]
                    await getCryptoNode(coin, network, remoteNodeVersion)
                } catch (err) {
                    reject(err)
                }
            }

            await buildCryptoNode(coin, network)
            await statusChanged()
            resolve(true)
        } else if (module == DB_MODULE_NAME) {
            try {
                await buildDatabaseModule(coin, network)
                await statusChanged()                 
                resolve(true)
            } catch (err){
                reject(err)
            }
        } else {
            let localModuleVersion = null
            try {
                localModuleVersion = await getLocalModuleVersion(module)
            } catch (err) {
                //Nothing localModuleVersion will be null
            }

            try {
                if (remoteUpdate || (localModuleVersion == null)) {
                    await cloneGit(module, true)
                }
                
                let containerId = await buildAndUp(module, coin, network, overwrite_container_id, onlyExecution)
                
                if ((module == XChainModule.XCHAIN_DECODER) || (module == XChainModule.XCHAIN_INDEXER)){
                    await setDatabaseParameters()
                }
                
                if (!onlyExecution){
                    await statusChanged()
                }
                resolve(containerId)
            } catch (err){
                reject(err)
            }
        }
        
        reject("Can't install the module, it doesn't exist")
    })
}

async function updateHub(){
    console.log("Updating hub...")
    
    return new Promise(async (resolve, reject) => {
        let defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
        let hubConnector = new HubConnector(defaultConfig["HUB_HOST"], defaultConfig["HUB_PORT"])
        await getStatus(null, null, false)
        
        if (statusUpdated){
            let jsonConfig = {}
                    
            for (let nextCoin in lastStatus){
                for (let nextNetwork in lastStatus[nextCoin]){
                    let defaultConfigCoinNetwork = await getDefaultConfig("", nextCoin, nextNetwork)
                
                    for (let nextModule in lastStatus[nextCoin][nextNetwork]){
                        let config = null
                        
                        switch (nextModule){
                            case DB_MODULE_NAME:
                                config = {
                                    "host":"mariadb",
                                    "port":3306
                                }
                                break
                            case NODE_MODULE_NAME:
                                config = {
                                    "host":defaultConfigCoinNetwork["NODE_URL"],
                                    "port":defaultConfigCoinNetwork["NODE_PORT"],
                                    "server_port":defaultConfigCoinNetwork["NODE_EXPOSED_PORT"],
                                    "user":defaultConfigCoinNetwork["NODE_USER"],
                                    "pass":defaultConfigCoinNetwork["NODE_PASSWORD"]
                                }
                                break
                            case XChainModule.XCHAIN_DECODER:
                                config = {
                                    "host":defaultConfigCoinNetwork["DECODER_URL"],
                                    "port":defaultConfigCoinNetwork["DECODER_API_PORT"],
                                    "server_port":defaultConfigCoinNetwork["DECODER_PORT"],
                                    "name":defaultConfigCoinNetwork["DECODER_DB_NAME"],
                                    "user":defaultConfigCoinNetwork["DECODER_DB_USER"],
                                    "pass":defaultConfigCoinNetwork["DECODER_DB_PASS"]
                                }
                                break
                            case XChainModule.XCHAIN_ENCODER:
                                config = {
                                    "host":defaultConfigCoinNetwork["ENCODER_URL"],
                                    "port":defaultConfigCoinNetwork["ENCODER_API_PORT"],
                                    "server_port":defaultConfigCoinNetwork["ENCODER_PORT"]
                                }
                                break
                            case XChainModule.XCHAIN_INDEXER:
                                config = {
                                    "host":defaultConfigCoinNetwork["INDEXER_HOST"],
                                    "port":defaultConfigCoinNetwork["INDEXER_API_PORT"],
                                    "server_port":defaultConfigCoinNetwork["INDEXER_PORT"],
                                    "name":defaultConfigCoinNetwork["INDEXER_DB_NAME"],
                                    "user":defaultConfigCoinNetwork["INDEXER_DB_USER"],
                                    "pass":defaultConfigCoinNetwork["INDEXER_DB_PASS"]
                                }
                                break
                            case XChainModule.XCHAIN_UTXO_TRACKER:
                                config = {
                                    "host":defaultConfigCoinNetwork["UTXO_TRACKER_URL"],
                                    "port":defaultConfigCoinNetwork["UTXO_TRACKER_API_PORT"],
                                    "server_port":defaultConfigCoinNetwork["UTXO_TRACKER_PORT"]
                                }
                                break
                            case XChainModule.XCHAIN_REGTEST_MINER:
                                config = {
                                    "host":defaultConfigCoinNetwork["REGTEST_MINER_URL"],
                                    "port":defaultConfigCoinNetwork["REGTEST_MINER_API_PORT"],
                                    "server_port":defaultConfigCoinNetwork["REGTEST_MINER_PORT"]
                                }
                                break   
                        }
                        
                        if (config != null){
                            if (!(nextCoin in jsonConfig)){
                                jsonConfig[nextCoin] = {}
                            }
                            if (!(nextNetwork in jsonConfig[nextCoin])){
                                jsonConfig[nextCoin][nextNetwork] = {}
                            }
                            if (!(nextModule in jsonConfig[nextCoin][nextNetwork])){
                                jsonConfig[nextCoin][nextNetwork][nextModule] = {}
                            }
                            jsonConfig[nextCoin][nextNetwork][nextModule] = config
                        }
                    }
                }
            }
            
            try {
                await hubConnector.updateConfig(jsonConfig)
            } catch (err){
                reject("There was a problem trying to update a config in the hub module")
            }
            
            resolve(true)
        } else {
            reject("The status is not updated")
        }
    })
}

async function installHubModule(){
    return new Promise(async (resolve, reject) => {
        let defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
        
        console.log("Checking if hub module is running")
        let hubConnector = new HubConnector(defaultConfig["HUB_HOST"], defaultConfig["HUB_PORT"])
        
        let pingHub = await hubConnector.ping()
        
        if (pingHub){
            resolve(true)
            return true //The hub is already installed and running
        } else {
            console.log("Checking if hub module is installed")
            if (statusUpdated){
                let hubModuleHasStatus = lastStatus?.[""]?.[""]?.[HUB_MODULE_NAME]
    
                if (hubModuleHasStatus !== undefined){
                    resolve(true)
                    return true
                }
            }
            
            //TODO: Checking if hub module is installed
            console.log("Downloading xchain-hub...")
            await cloneGit(HUB_MODULE_NAME, true)
            console.log("Installing hub module...")
            await buildAndUp(HUB_MODULE_NAME, null, null)
            await getStatus(null, null, false)
            
            console.log("Waiting for the hub to respond")
            
            let tries = 10
            
            while (tries > 0){
                pingHub = await hubConnector.ping()
                
                if (pingHub){
                    //pass data to the hub
                    await updateHub()
                
                    resolve(true)
                    return true
                } else {
                    
                }
                
                tries = tries - 1
            }
            
            reject("Couldn't install hub module")
        }
    })
}

async function installNode(coin, network){
    console.log("Creating xchain docker network...")
    await createDockerNetwork(coin, network)
    
    console.log("Installing database...")
    await buildDatabaseModule(coin, network)
    
    console.log("Installing " + coin + " " + network + " node...")
    let localNodeVersion = null
    try {
        localNodeVersion = await getLocalNodeVersion(coin, network)
    } catch (err) {
        console.log(err)
    }

    if (localNodeVersion == null) {
        let remoteNodeVersion = remoteModuleVersions[NODE_MODULE_NAME + "_" + coin]["tag_name"]
        
        if (remoteNodeVersion != null){
            await getCryptoNode(coin, network, remoteNodeVersion)
        } else {
            throw Error("There is no valid version to download for the $coin/$network node")
        }
    }
    await buildCryptoNode(coin, network)
    
    console.log("Downloading xchain-encoder...")
    //let localXchainEncoderVersion = await getLocalModuleVersion(XChainModule.XCHAIN_ENCODER)
    //let remoteXchainEncoderVersion = await getRemoteModuleVersion(XChainModule.XCHAIN_ENCODER)
    //let containerXchainEncoderVersion = await getContainerModuleVersion(XChainModule.XCHAIN_ENCODER)
    
    await cloneGit(XChainModule.XCHAIN_ENCODER, true)
    console.log("Building xchain-encoder container...")
    await buildAndUp(XChainModule.XCHAIN_ENCODER, coin, network)
    
    console.log("Downloading xchain-decoder...")
    await cloneGit(XChainModule.XCHAIN_DECODER, true)
    console.log("Building xchain-decoder container...")
    await buildAndUp(XChainModule.XCHAIN_DECODER, coin, network)
    
    console.log("Downloading xchain-utxo-tracker...")
    await cloneGit(XChainModule.XCHAIN_UTXO_TRACKER, true)
    console.log("Building xchain-utxo-tracker...")
    await buildAndUp(XChainModule.XCHAIN_UTXO_TRACKER, coin, network)
    
    if (network == Network.REGTEST){
        console.log("Downloading xchain-regtest-miner...")
        await cloneGit(XChainModule.XCHAIN_REGTEST_MINER, true)
        console.log("Building xchain-regtest_miner...")
        await buildAndUp(XChainModule.XCHAIN_REGTEST_MINER, coin, network)
    }
    
    console.log("Downloading xchain-indexer...")
    await cloneGit(XChainModule.XCHAIN_INDEXER, true)
    console.log("Building xchain-indexer...")
    await buildAndUp(XChainModule.XCHAIN_INDEXER, coin, network)
    
    try {
        await setDatabaseParameters()
    } catch(err){
        console.log("WARNING! The database parameters couldn't be set")
    }
    
    
    await statusChanged()
                    
    return true
}

async function restoreBootstrapInterface(coin, network, module){
    return new Promise(async (resolve, reject) => {
        let bootstrapFiles = await getBootstrapFilesList(coin, network, module)
        
        let moduleChoices = []
        
        for (let nextFileName of bootstrapFiles){
            moduleChoices.push(
                {name:nextFileName, value:nextFileName}
            )
        }
        
        moduleChoices.push(
            {name:"Return", value:"return"}
        )
        
        let modulesSelect = new Select({
            name: 'action',
            message: 'Which bootstrap do you want to restore?',
            choices: moduleChoices
        })
        
        modulesSelect.run().then(
            async (moduleAnswer) => {
                if (moduleAnswer == "Return"){
                    resolve(true)
                } else {
                    await restoreBootstrap(coin, network, module, moduleAnswer)
                }
            }
        )
    })
}

async function modulesSelectionInterface(coin, network){
    return new Promise(async (resolve, reject) => {
        //let modulesStatus = await getStatus(coin, network, false)
        let modulesStatus = await getStatus(null, null, false)
    
        let moduleChoices = []
        let actionModules = {}
        
        let onlyOneModuleUsingDatabase = false //If the module database is used by many modules, then it can't be removed
        
        if ((coin in modulesStatus) && (network in modulesStatus[coin])){
            onlyOneModuleUsingDatabase = !((modulesStatus.length > 2) || (modulesStatus[coin].length > 1)) //If the database module exists, it will count as one        
        
            //Add the database module to the coin
            if (("" in modulesStatus) && ("" in modulesStatus[""]) && (DB_MODULE_NAME in modulesStatus[""][""])){
                modulesStatus[coin][network][DB_MODULE_NAME] = modulesStatus[""][""][DB_MODULE_NAME]
            }
        
            let allModules = Object.values(XChainModule)
            
            //Remove e2eTest module from all networks, TODO: get the list of installable modules
            let e2eTestIndex = allModules.indexOf(XChainModule.XCHAIN_E2E_TEST)
                
            if (e2eTestIndex >= 0){
                allModules.splice(e2eTestIndex, 1)
            }
            
            //Leave regtest miner only for REGTEST network
            if (network != Network.REGTEST){
                let regtestMinerIndex = allModules.indexOf(XChainModule.XCHAIN_REGTEST_MINER)
                
                if (regtestMinerIndex >= 0){
                    allModules.splice(regtestMinerIndex, 1)
                }
            }
            
            allModules.push(NODE_MODULE_NAME)
            allModules.push(DB_MODULE_NAME)
        
            for (let nextModuleIndex in modulesStatus[coin][network]){
                //let key = nextModuleIndex+" ("+modulesStatus[coin][network][nextModuleIndex]["status"]["State"]["Status"]+")"
                let moduleStatus = modulesStatus[coin][network][nextModuleIndex]["status"]["State"]["Status"]
                let key = ""
                
                if (moduleStatus == "exited"){
                    key = "\x1b[31m"+nextModuleIndex+" ("+moduleStatus+")"+"\x1b[37m"
                } else {
                    key = "\x1b[32m"+nextModuleIndex+" ("+moduleStatus+")"+"\x1b[37m"
                }
                
                moduleChoices.push({
                    name:key,
                    value:nextModuleIndex
                })
                
                actionModules[key] = {
                    "value":nextModuleIndex, 
                    "container_id": modulesStatus[coin][network][nextModuleIndex]["container_id"], 
                    "status":moduleStatus
                }
                
                var moduleIndex = allModules.indexOf(nextModuleIndex)
                if (moduleIndex !== -1) {
                    allModules.splice(moduleIndex, 1)
                }
            }
            
            for (let nextModuleIndex in allModules){
                let nextModule = allModules[nextModuleIndex]
                let key = "\x1b[34m"+nextModule+" (missing)"+"\x1b[37m"
                    
                moduleChoices.push({
                    name: key,
                    value: nextModule
                })
                    
                actionModules[key] = {
                    "value":nextModule, 
                    "status":"missing"
                }           
            }
            
            moduleChoices.push(
                {name:"Uninstall all the modules", value:"Uninstall all the modules"}
            )
            moduleChoices.push(
                {name:"Return", value:"return"}
            )
        } else {
            moduleChoices.push(
                {name:"Install the node", value:"Install the node"}
            )
            moduleChoices.push(
                {name:"Return", value:"return"}
            )
        }
        
        if (network == Network.REGTEST){
            moduleChoices.splice(moduleChoices.length-2, 0, {name:"Perform an E2E test", value:"e2etest"})
        }
        
        let modulesSelect = new Select({
            name: 'action',
            message: 'In which module do you want to perform actions?',
            choices: moduleChoices
        })
        
        modulesSelect.run().then(
            async (moduleAnswer) => {
                if (moduleAnswer == "Return"){
                    resolve({
                        menuFunction:mainMenu, 
                        parameters:[]
                    })
                } else if (moduleAnswer == "Uninstall all the modules"){
                    for (nextKey in actionModules){
                        let nextActionModule = actionModules[nextKey]
                        
                        if ((nextActionModule["value"] != DB_MODULE_NAME) || (onlyOneModuleUsingDatabase)){
                            if (nextActionModule["status"] != "missing"){
                                try {
                                    if (nextActionModule["status"] != "exited"){
                                        await killContainer(nextActionModule["container_id"])
                                    }
                                    await removeContainer(nextActionModule["container_id"])
                                    //TODO: remove module from database
                                } catch (err){
                                    console.log("There was a problem trying to kill a container")
                                }
                            }
                        }
                    }
                    
                    resolve({
                        menuFunction:modulesSelectionInterface, 
                        parameters:[coin, network]
                    })
                } else if (moduleAnswer == "Install the node"){
                    try {
                        await installNode(coin, network)
                    } catch(err){
                        console.log("There was a problem installing the node")
                        console.log(err)
                    }
                    
                    resolve({
                        menuFunction:modulesSelectionInterface, 
                        parameters:[coin, network]
                    })
                } else if (moduleAnswer == "Perform an E2E test"){
                    try {
                        let containerId = await installModule(coin, network, XChainModule.XCHAIN_E2E_TEST, true)
                        console.log("The e2e test was performed in container "+containerId)
                    } catch (err) {
                        console.log(err)
                        console.log("There was a problem trying to install the e2e test module")
                    }
                    
                    resolve({
                        menuFunction:modulesSelectionInterface, 
                        parameters:[coin, network]
                    })
                } else if (moduleAnswer in actionModules){
                    let selectedModuleStatus = actionModules[moduleAnswer]["status"]

                    //Getting all module versions
                    let remoteModuleVersion = "0"
                    try {
                        if (actionModules[moduleAnswer]["value"] == NODE_MODULE_NAME) {
                            remoteModuleVersion = await remoteModuleVersions[actionModules[moduleAnswer]["value"] + "_" + coin]["version"]
                        } else {
                            remoteModuleVersion = await remoteModuleVersions[actionModules[moduleAnswer]["value"]]
                        }
                    } catch {
                        //Nothing yet
                    }
                    let localeModuleVersion = "0"
                    try {
                        if (actionModules[moduleAnswer]["value"] == NODE_MODULE_NAME) {
                            localeModuleVersion = await getLocalNodeVersion(coin, network)
                        } else {
                            localeModuleVersion = await getLocalModuleVersion(actionModules[moduleAnswer]["value"])
                        }
                    } catch {
                        //Nothing yet
                    }

                    if (selectedModuleStatus != "missing") {
                        let containerModuleVersion = "0"
                        try {
                            if (actionModules[moduleAnswer]["value"] == NODE_MODULE_NAME) {
                                containerModuleVersion = await getContainerNodeVersion(coin, network, actionModules[moduleAnswer]["container_id"])
                            } else {
                                containerModuleVersion = await getContainerModuleVersion(actionModules[moduleAnswer]["value"], coin, network, actionModules[moduleAnswer]["container_id"])
                            }
                        } catch {
                            //Nothing yet
                        }

                        let moduleActions = []
                        
                        if (selectedModuleStatus == "exited"){
                            moduleActions.push({name: "Restart", value: "restart"})
                        }
                        
                        if (semver.valid(localeModuleVersion)) {
                            if (semver.valid(remoteModuleVersion)){
                                if (semver.gt(remoteModuleVersion, localeModuleVersion)) {
                                    moduleActions.push({ name: "Update locale version", value: "update locale version" })
                                } else if (semver.eq(remoteModuleVersion, localeModuleVersion)) {
                                    moduleActions.push({ name: "Reinstall from remote", value: "reinstall from remote" })
                                }
                            } 

                            if (semver.valid(containerModuleVersion)) {
                                if (semver.gt(localeModuleVersion, containerModuleVersion)) {
                                    moduleActions.push({ name: "Update Container", value: "update container" })
                                } else if (semver.lt(localeModuleVersion, containerModuleVersion) || semver.eq(localeModuleVersion, containerModuleVersion)) {
                                    moduleActions.push({ name: "Reinstall", value: "reinstall" })
                                }
                            } else {
                                moduleActions.push({ name: "Install Local Version in Container", value: "install local version in container" })
                            }
                        } else {
                            if (semver.valid(remoteModuleVersion)) {
                                moduleActions.push({ name: "Update locale version", value: "update locale version" })
                            }
                        }

                        let modulesActionSelect = new Select({
                            name: 'action',
                            message: 'What do you want to do with the selected module?',
                            choices: moduleActions
                        })

                        if (actionModules[moduleAnswer]["value"] != DB_MODULE_NAME) {
                            moduleActions.push({ name: "Uninstall", value: "uninstall" })
                            
                            if (actionModules[moduleAnswer]["value"] == XChainModule.XCHAIN_UTXO_TRACKER){
                                moduleActions.push({ name: "Make Bootstrap", value: "make_bootstrap"})
                                moduleActions.push({ name: "Restore Bootstrap", value: "restore_bootstrap"})
                            }
                            
                        }

                        moduleActions.push({ name: "Return", value: "return" })

                        modulesActionSelect.run().then(
                            async (moduleActionAnswer) => {
                                if (moduleActionAnswer == "Uninstall") {
                                    try {
                                        if (selectedModuleStatus != "exited") {
                                            await killContainer(actionModules[moduleAnswer]["container_id"])
                                        }

                                        await removeContainer(actionModules[moduleAnswer]["container_id"])
                                        //TODO: remove module from database
                                    } catch (err) {
                                        console.log(err)
                                        console.log("There was a problem trying to kill/remove a container")
                                    }
                                } else if (moduleActionAnswer == "Restart") {
                                    try {
                                        await restartContainer(actionModules[moduleAnswer]["container_id"])
                                    } catch (err) {
                                        console.log(err)
                                        console.log("There was a problem trying to restart a container")
                                    }
                                } else if (moduleActionAnswer == "Update locale version") {
                                    await cloneGit(actionModules[moduleAnswer]["value"], true, false)
                                    //Not developed yet
                                } else if ((moduleActionAnswer == "Update container version") || (moduleActionAnswer == "Install Local Version in Container")) {
                                    //Not developed yet
                                    await installModule(coin, network, actionModules[moduleAnswer]["value"], false, actionModules[moduleAnswer]["container_id"])
                                } else if (moduleActionAnswer == "Make Bootstrap") {
                                    //Not developed yet
                                    await makeBootstrap(coin, network, actionModules[moduleAnswer]["value"])
                                } else if (moduleActionAnswer == "Restore Bootstrap"){
                                    await restoreBootstrapInterface(coin, network, actionModules[moduleAnswer]["value"])
                                } else if (moduleActionAnswer == "Reinstall from remote"){
                                    //Rewrite module dir
                                    await cloneGit(actionModules[moduleAnswer]["value"], true)
                                    await installModule(coin, network, actionModules[moduleAnswer]["value"], false, actionModules[moduleAnswer]["container_id"])
                                }
                                
                                resolve({
                                    menuFunction:modulesSelectionInterface, 
                                    parameters:[coin, network]
                                })
                            }
                        )
                    } else {
                        let moduleActions = []

                        if (localeModuleVersion != "0") {
                            moduleActions.push({ name: "Install from local", value: "install from local" })
                        } else {
                            moduleActions.push({ name: "Install", value: "install"})
                        }

                        moduleActions.push({name: "Return", value: "return"})
                        
                        let modulesActionSelect = new Select({
                            name: 'action',
                            message: 'What do you want to do with the selected module?',
                            choices: moduleActions
                        })
                        
                        modulesActionSelect.run().then(
                            async (moduleActionAnswer) => {
                                if (moduleActionAnswer == "Install") {
                                    try {
                                        await installModule(coin, network, actionModules[moduleAnswer]["value"], true)
                                    } catch (err) {
                                        console.log(err)
                                        console.log("There was a problem trying to install the module")
                                    }
                                } else if (moduleActionAnswer == "Install from local"){
                                    try {
                                        await installModule(coin, network, actionModules[moduleAnswer]["value"], false)
                                    } catch (err) {
                                        console.log(err)
                                        console.log("There was a problem trying to install the module from local")
                                    }

                                }
                                
                                resolve({
                                    menuFunction:modulesSelectionInterface, 
                                    parameters:[coin, network]
                                })
                            }
                        )
                    }
                }
            }
        )
    })
}

function exit(){
    process.exit()
}

async function scanModules(){
    return new Promise(async (resolve, reject) => {
        exec('docker ps -a --no-trunc --format json', async (error, stdout, stderr) => {
            const containers = stdout.trim()
              .split('\n').filter(line => line.trim().length > 0) //Separate the stdout in lines
              .map(line => JSON.parse(line)) //parse every line as a JSON
            
            
            for (let nextContainerIndex in containers){
                let nextContainer = containers[nextContainerIndex]
                let imageName = nextContainer.Image
                
                if (imageName.startsWith(NODE_PREFIX)){
                    imageName = imageName.substr(NODE_PREFIX.length+1)// +1 because of the additional underscore ("_")
                    let separatedImageName = imageName.split("_")
                    
                    if ((separatedImageName.length == 1)
                        &&(separatedImageName[0] == DB_MODULE_NAME)){
                        
                    } else if (separatedImageName.length == 2){
                        let {coin,network} = stringToNetwork(separatedImageName[0])
                        coin = Coin[coin]
                        network = Network[network]
                        if ((coin != null) && (network != null)){
                            let module = stringToXChainModule(separatedImageName[1])
                            
                            if (module != null){
                                module = XChainModule[module]
                            } else {
                                if (separatedImageName[1] == NODE_MODULE_NAME){
                                    module = NODE_MODULE_NAME
                                }
                            }
                            
                            if (module != null){
                                let moduleDb = await db.getModuleContainer(module, coin, network)
                                
                                if (moduleDb == null){//It's not in the database
                                    await db.insertModuleContainer(module, coin, network, nextContainer.ID)
                                    console.log("Added "+coin+"-"+network+"_"+module+" ("+nextContainer.ID+")")
                                }
                            }
                        }
                    }
                }
            }
            resolve(true)
        })
    })
}

function mainMenu(){
    return new Promise(async (resolve, reject) => {
        let coinPrompt = new Select({
            name: "coin",
            message: "Select the coin",
            choices: Object.values(Coin)
        })
        
        
        let networkPrompt = new Select({
            name: "network",
            message: "Select the network",
            choices: Object.values(Network)
        })
        
        let modulesStatus = await getStatus(null, null, true)
        let moduleCoinsChoices = []
        
        for (let nextCoinIndex in modulesStatus){
            //let nextCoin = modulesStatus[nextCoinIndex]
            
            moduleCoinsChoices.push({
                name:nextCoinIndex,
                value:nextCoinIndex
            })
        }
            
        let modulesCoins = new Select({
            name: 'action',
            message: 'Select a coin to check the installed modules',
            choices: moduleCoinsChoices
        })
        
        
        let prompt = new Select({
            name: 'action',
            message: 'Select a coin and a network to check the status and install/uninstall modules',
            choices: 
                Object.values(Coin).concat(
                    [
                        {name:'Install/Configure database',value:'configure_database'},
                        {name:'Scan already installed modules',value:'scan_modules'},
                        {name:'Exit',value:'exit'}
                    ]
                )
        });

        prompt.run().then(
            async (answer) => {
                if (answer == "Exit"){
                    console.log("Bye!")
                    resolve({
                        menuFunction:exit,
                        parameters:[]
                    })
                } else if (answer == "Install/Configure database"){
                    try {
                        await buildDatabaseModule("","")
                        await setDatabaseParameters()
                    } catch(err){
                        console.log("WARNING! The database parameters couldn't be set")
                        console.log(err)
                    }
                    
                    resolve({
                        menuFunction:mainMenu, 
                        parameters:[]
                    })
                } else if (answer == "Scan already installed modules"){ 
                    try {
                        await scanModules()
                    } catch(err){
                        console.log(err)
                    }
                    
                    resolve({
                        menuFunction:mainMenu, 
                        parameters:[]
                    })
                } else {
                    networkPrompt.run().then(
                        async (networkAnswer) => {
                            resolve({
                                menuFunction:modulesSelectionInterface, 
                                parameters:[answer, networkAnswer]
                            })
                        }
                    )
                }
            }
        ).catch(
            console.log(console.error)
        )
    })
}




const startInterface = async() => {
    console.log("Xchain-Node ver 0.0.0")
    console.log("")
    
    let menuFunction = mainMenu
    let parameters = []
    let menuFunctionParameters
    
    while (true){
        menuFunctionParameters = await menuFunction(...parameters)
        menuFunction = menuFunctionParameters["menuFunction"]
        parameters = menuFunctionParameters["parameters"]
    }
}

async function start(){
    createDirectories()
    await checkAllRemoteVersions()
    await db.createDatabase()
    await getStatus(null, null, false)
    
    try {
        await installHubModule()
    } catch (err) {
        throw new Error("There was an error trying to install the hub module")
    }
    
    try{
        await updateHub() //Force a hub update
    } catch (err){
        console.log(err)
        throw new Error("There was an error trying to update the hub module")
    }
    
    try {
        await checkDockerInstalledAndReachable()
    } catch(err){
        throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
    }
    
    await startInterface()
}

start()