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

const { exec }                     = require('child_process')
const { promisify }                = require('util');
const execAsync                    = promisify(exec);
const { https }                    = require('follow-redirects');
const fs                           = require("fs");
const readline                     = require('readline')
const path                         = require("path")
const LevelUpStore                 = require('./LevelUpDb.js')
const GitHubDownloader             = require('./GitHubDownloader.js')
const mariadb                      = require('mariadb')
const semver                       = require('semver')
const axios                        = require('axios')
const HubConnector                 = require('./HubConnector.js')
const { Command }                  = require('commander');
const { version }                  = require('../package.json');
const ExplorerConnector            = require('./ExplorerConnector.js')
const DockerManager                = require('./DockerManager.js')

//Console interface
const { prompt, Select, Password } = require('enquirer');

// Parse in .env config data
dotenv.config();

// Define some constants used throughout the codebase
const NODE_PREFIX            = (process.env.NODE_PREFIX) ? process.env.NODE_PREFIX : "xchain-node";
const DB_NAME                = (process.env.DB_NAME == null) ? "xchain_node" : process.env.DB_NAME;
const NODE_MODULE_NAME       = "node";
const DB_MODULE_NAME         = "database";
const HUB_MODULE_NAME        = "xchain-hub";
const EXPLORER_MODULE_NAME   = "xchain-explorer"
const NODE_VERSION_FILE_NAME = "__VERSION__.txt";
const SEP                    = "-";
const DB_SEP                 = "_";
const HUB_PORT               = 10000;

// Define some directory paths
const moduleDir          = path.join(__dirname, "..", "modules")
const tmpDir             = path.join(__dirname, "..", "tmp")
const srcDir             = path.join(__dirname, "..", "src")
const cryptoNodesDir     = path.join(__dirname,"..","crypto_nodes")
const dataDir            = path.join(__dirname,"..","data")
const configDir          = path.join(__dirname,"..","config")
const containersFilesDir = path.join(tmpDir, "containers_files")

// Parse in the node version
const nodeVersion = process.versions.node;

// Define some placeholders
var dbRootPassword       = null;
var installedModules     = {};
var remoteModuleVersions = {};
var statusUpdated        = false;
var lastStatus           = null;
var printedStatus        = "";

// Define list of XChain services
const XChainService = {
    XCHAIN_ENCODER:       "xchain-encoder",
    XCHAIN_DECODER:       "xchain-decoder",
    XCHAIN_UTXO_TRACKER:  "xchain-utxo-tracker",
    XCHAIN_REGTEST_MINER: "xchain-regtest-miner",
    XCHAIN_INDEXER:       "xchain-indexer",
    XCHAIN_E2E_TEST:      "xchain-e2e-test"
};

const REGTEST_MODULES = [
    XChainService.XCHAIN_REGTEST_MINER,
    XChainService.XCHAIN_E2E_TEST
]

// Define list of project folders
const projectFolders = {
    "xchain-encoder":       "XChainEncoder",
    "xchain-decoder":       "XChainDecoder",
    "xchain-utxo-tracker":  "XChainUtxoTracker",
    "xchain-regtest-miner": "XChainRegtestMiner",
    "xchain-indexer":       "XChainIndexer",
    "xchain-hub":           "XChainHub",
    "xchain-explorer":      "XChainExplorer",
    "xchain-e2e-test":      "XChainE2ETest"
}

var dbRootPassword = null

var installedModules = {}

/*const modulesUrls = {
    "xchain-encoder": "https://github.com/XChain-platform/xchain-encoder",
    "xchain-decoder": "https://github.com/XChain-platform/xchain-decoder",
    "xchain-utxo-tracker": "https://github.com/XChain-platform/xchain-utxo-tracker",
    "xchain-indexer": "https://github.com/XChain-platform/xchain-indexer",
    "xchain-regtest-miner": "https://github.com/XChain-platform/xchain-regtest-miner",
    "xchain-hub": "https://github.com/XChain-platform/xchain-hub",
    "xchain-explorer": "https://github.com/XChain-platform/xchain-explorer",
    "xchain-e2e-test": "https://github.com/XChain-platform/xchain-e2e-test"
}*/

var remoteModuleVersions = {}

const modulesUrls = {
    "xchain-encoder":       "git@github.com:XChain-platform/xchain-encoder.git",
    "xchain-decoder":       "git@github.com:XChain-platform/xchain-decoder.git",
    "xchain-utxo-tracker":  "git@github.com:XChain-platform/xchain-utxo-tracker.git",
    "xchain-indexer":       "git@github.com:XChain-platform/xchain-indexer.git",
    "xchain-regtest-miner": "git@github.com:XChain-platform/xchain-regtest-miner.git",
    "xchain-hub": "git@github.com:XChain-platform/xchain-hub.git",
    "xchain-explorer": "git@github.com:XChain-platform/xchain-explorer.git",
    "xchain-e2e-test": "git@github.com:XChain-platform/xchain-e2e-test.git"
}

// Define list of supported coins
const Coin = {
    BITCOIN:  "bitcoin",
    DOGECOIN: "dogecoin",
    LITECOIN: "litecoin"
};

// Define list of supported networks
const Network = {
    MAINNET: "mainnet",
    TESTNET: "testnet",
    REGTEST: "regtest"
};

// Define list of coin symbols
const CoinTickerSymbol = {
    "bitcoin":  "BTC",
    "dogecoin": "DOGE",
    "litecoin": "LTC"
};

// Initializing the database
const db               = new LevelUpStore(DB_NAME, dataDir)
const gitHubDownloader = new GitHubDownloader(srcDir+"/github_hashes.json")
const dockerManager    = new DockerManager()

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle creating directories
function createDirectories(){
    if(!fs.existsSync(dataDir))
        fs.mkdirSync(dataDir)
    if(!fs.existsSync(moduleDir))
        fs.mkdirSync(moduleDir)
    if(!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir)
    if(!fs.existsSync(containersFilesDir))
        fs.mkdirSync(containersFilesDir)
}


function stringToCoin(coinString){
    for(let nextCoinIndex in Coin){
        if(Coin[nextCoinIndex] == coinString)
            return nextCoinIndex;
    }
    return null;
}

function stringToXChainService(serviceString){
    for (let nextXchainServiceIndex in XChainService){
        if (XChainService[nextXchainServiceIndex] == serviceString){
            return nextXchainServiceIndex
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
        getRemoteModuleVersion(XChainService.XCHAIN_ENCODER),
        getRemoteModuleVersion(XChainService.XCHAIN_DECODER),
        getRemoteModuleVersion(XChainService.XCHAIN_UTXO_TRACKER),
        getRemoteModuleVersion(XChainService.XCHAIN_REGTEST_MINER),
        getRemoteModuleVersion(XChainService.XCHAIN_INDEXER),
        getRemoteModuleVersion(EXPLORER_MODULE_NAME)
    ])
}

async function getBootstrapFilesList(coin, network, module){
    return new Promise(async (resolve, reject)=>{
        let defaultConfig = await getDefaultConfig(module, coin, network)
        let fileList = []
            
        try {
            let directory = null
            
            switch(module){
                case XChainService.XCHAIN_UTXO_TRACKER:
                    directory = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"];
                    break
                case XChainService.XCHAIN_DECODER:
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
            case XChainService.XCHAIN_UTXO_TRACKER:
                let port = defaultConfig["UTXO_TRACKER_PORT"]
                let moduleDockerVolume = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
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
                
        let fileName = network+SEP+module+SEP+dateTimeString
                
        
        switch (module){
            case XChainService.XCHAIN_UTXO_TRACKER:
                let port = defaultConfig["UTXO_TRACKER_PORT"]
                let moduleDockerVolume = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
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
                        console.log("The bootstrap file is in "+moduleDockerVolume+fileName)
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

    remoteModuleVersions["node"+SEP+coin] = githubProjectVersion
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

        //if (module == XChainService.XCHAIN_INDEXER) {
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
    if ((module == DB_MODULE_NAME) || (module == HUB_MODULE_NAME) || (module == EXPLORER_MODULE_NAME)){
        return NODE_PREFIX
    } else {
        return NODE_PREFIX + SEP + coin + SEP + network
    }
}

function getModuleDatabaseName(module, coin, network){
    let moduleName = module.slice("xchain-".length)
    
    return "XChain" + DB_SEP +
        CoinTickerSymbol[coin] + DB_SEP +
        network.charAt(0).toUpperCase() + network.slice(1) + DB_SEP +
        moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
}

async function stringToDockerContainerFile(containerId, dataString, filePath) {
    return new Promise((resolve, reject) => {
        exec("docker exec -i ${containerId} sh -c 'cat > ${filePath}'", { input: dataString }, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                resolve(true)
            }
        })
    })
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
    return getDockerContainerImageNamePrefix(module, coin, network) + SEP + module
}

async function getStatusFromContainer(containerId){
    return new Promise((resolve, reject) => {
        try {
            exec('docker inspect '+containerId, (error, stdout, stderr) => {
                if (error){
                    reject(error)
                } else {
                    resolve(JSON.parse(stdout)[0])
                }
            })
        } catch (err){
            reject(err)
        }
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
    return NODE_PREFIX +
        (coin != ""?SEP+coin:"") +
        (network != ""?SEP+network:"")
}

async function createDockerNetwork(coin, network){
    return new Promise((resolve, reject) => {
        let network_name = getDockerNetwork(coin, network)
    
        //Check if network exists
        exec('docker network inspect '+network_name, (error, stdout, stderr) => {
            if (error){//It means the network doesn't exist
                console.log("Creating docker network "+network_name)
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
        let noCoinModules = 
            (module == DB_MODULE_NAME || 
            module == HUB_MODULE_NAME || 
            module == EXPLORER_MODULE_NAME)
    
        let moduleContainerId = await db.getModuleContainer(
            module, 
            (noCoinModules?"":coin), 
            (noCoinModules?"":network)
        )
        
        //Check if the module is connected to the network already
        let containerStatus = await getStatusFromContainer(moduleContainerId)

        if (!(getDockerNetwork(coin, network) in containerStatus["NetworkSettings"]["Networks"])){
            console.log("Connecting module "+module+" to network "+getDockerNetwork(coin, network))
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
            "UTXO_TRACKER_URL":getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coin, network),
            "UTXO_TRACKER_API_PORT":3001,
            "UTXO_TRACKER_PORT":3001,
            "UTXO_TRACKER_BOOTSTRAP_VOLUME":dataDir+"/"+coin+"/"+network+"/"+module+"/bootstrap/",
            "DECODER_DB_NAME":getModuleDatabaseName(XChainService.XCHAIN_DECODER,coin,network),
            //"DECODER_DB_HOST":DB_MODULE_NAME,
            "DECODER_DB_HOST":"mariadb",
            "DECODER_DB_PORT":3306,
            "DECODER_DB_USER":"xchain"+DB_SEP+"decoder"+DB_SEP+coin+DB_SEP+network,
            "DECODER_DB_PASS":"xchain"+SEP+"password",
            "DECODER_URL":getDockerContainerImageName(XChainService.XCHAIN_DECODER, coin, network),
            "DECODER_API_PORT":3002,
            "DECODER_PORT":3002,
            "DECODER_BOOTSTRAP_VOLUME":dataDir+"/"+coin+"/"+network+"/"+module+"/bootstrap/",
            "ENCODER_URL":getDockerContainerImageName(XChainService.XCHAIN_ENCODER, coin, network),
            "ENCODER_API_PORT":3003,
            "ENCODER_PORT":3003,
            "INDEXER_HOST":getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_API_PORT":3004,
            "INDEXER_PORT":3004,
            "INDEXER_COIN":CoinTickerSymbol[coin],
            "INDEXER_NETWORK":network,
            //"INDEXER_DB_HOST":DB_MODULE_NAME,
            "INDEXER_DB_HOST":"mariadb",
            "INDEXER_DB_PORT":3306,
            "INDEXER_DB_NAME":getModuleDatabaseName(XChainService.XCHAIN_INDEXER,coin,network),
            "INDEXER_DB_USER":"xchain"+DB_SEP+"indexer"+DB_SEP+coin+DB_SEP+network,
            "INDEXER_DB_PASS":"xchain"+SEP+"password",
            "HUB_HOST":"127.0.0.1",
            "HUB_API_HOST":getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":10000
        }
        
        if (network == "regtest"){
            defaultValues["REGTEST_MINER_URL"] = getDockerContainerImageName(XChainService.XCHAIN_REGTEST_MINER, coin, network)
            defaultValues["REGTEST_MINER_API_PORT"] = 3005,
            defaultValues["REGTEST_MINER_PORT"] = 3005
        }
        
    } else {
        defaultValues = {
            "HUB_HOST":"127.0.0.1",
            "HUB_API_HOST":getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":10000,
            "EXPLORER_HOST":"127.0.0.1",
            "EXPLORER_PORT":18080,
            "EXPLORER_API_HOST":getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
            "EXPLORER_API_USER":false,
            "EXPLORER_API_PASS":false,
            "EXPLORER_API_PORT_HTTP":8080,
            "EXPLORER_PORT_HTTP":18080,
            "EXPLORER_API_PORT_HTTPS":8081,
            "EXPLORER_PORT_HTTPS":18081
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
                +'-v '+dataDir+"/"+NODE_MODULE_NAME+"/"+coin+"/"+network+":/root/."+coin+" "
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
        
        let explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, null, null)
        
        for (let nextCoin in installedCoinsAndNetworks){
            for (let nextNetworkIndex in installedCoinsAndNetworks[nextCoin]){
                let nextNetwork = installedCoinsAndNetworks[nextCoin][nextNetworkIndex]
                
                //Verify if mariadb container is in the docker network of this coin and network
                try {
                    await addContainerToNetwork(DB_MODULE_NAME, nextCoin, nextNetwork)
                    
                    let moduleContainerId = await db.getModuleContainer(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
                    if (moduleContainerId != null){
                        let defaultConfig = await getDefaultConfig(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)                  
                        await addUserPasswordToDatabase(
                            XChainService.XCHAIN_DECODER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["DECODER_DB_NAME"],
                            defaultConfig["DECODER_DB_USER"],
                            defaultConfig["DECODER_DB_PASS"]
                        )
                    }
                    moduleContainerId = await db.getModuleContainer(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)
                    if (moduleContainerId != null){
                        let defaultConfig = await getDefaultConfig(XChainService.XCHAIN_INDEXER, nextCoin, nextNetwork)                  
                        await addUserPasswordToDatabase(
                            XChainService.XCHAIN_INDEXER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["INDEXER_DB_NAME"],
                            defaultConfig["INDEXER_DB_USER"],
                            defaultConfig["INDEXER_DB_PASS"]
                        )
                        await addUserPasswordToDatabase(
                            XChainService.XCHAIN_INDEXER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["DECODER_DB_NAME"],
                            defaultConfig["DECODER_DB_USER"],
                            defaultConfig["DECODER_DB_PASS"]
                        )
                    }
                    moduleContainerId = await db.getModuleContainer(XChainService.XCHAIN_EXPLORER, nextCoin, nextNetwork)
                    if (moduleContainerId != null){
                        let defaultConfig = await getDefaultConfig(XChainService.XCHAIN_EXPLORER, nextCoin, nextNetwork)                  
                        await addContainerToNetwork(XCHAIN_EXPLORER, nextCoin, nextNetwork)
                        await addUserPasswordToDatabase(
                            XChainService.XCHAIN_EXPLORER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["EXPLORER_DB_NAME"],
                            defaultConfig["EXPLORER_DB_USER"],
                            defaultConfig["EXPLORER_DB_PASS"]
                        )
                        await addUserPasswordToDatabase(
                            XChainService.XCHAIN_INDEXER,
                            nextCoin,
                            nextNetwork,
                            defaultConfig["EXPLORER_DB_NAME"],
                            defaultConfig["EXPLORER_DB_USER"],
                            defaultConfig["EXPLORER_DB_PASS"]
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
        let mariadbRootPassword = await askMariadbRootPassword(coin, network)
        
        let moduleContainerId = await db.getModuleContainer(module, coin, network)
        let containerStatus = await getStatusFromContainer(moduleContainerId)
        let dockerNetwork = getDockerNetwork(coin, network)
        let docketNetworkInspect = await getDockerNetworkInspect(dockerNetwork)
        
        let gatewayIp = docketNetworkInspect["IPAM"]["Config"][0]["Gateway"]
        let gatewayIpSplit = gatewayIp.split(".")
        gatewayIp = gatewayIpSplit[0]+"."+gatewayIpSplit[1]+".0.0"
        
        let host = gatewayIp+"/255.255.0.0"
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
                userGrants = userGrants.replaceAll("`","'")
                userGrants = userGrants.split("\n")
                if (!userGrants.includes("GRANT ALL PRIVILEGES ON '"+databaseName+"'.* TO "+mariadbUser)){
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
        try {
            let dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
            
            let containerStatus = await getStatusFromContainer(dbContainerId)
            
            if (("State" in containerStatus) && ("Status" in containerStatus["State"])){
                resolve(dbContainerId)
            } else {
                resolve(null)
            }
        } catch (err) {
            resolve(null)
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
        if (dbRootPassword){
            resolve(dbRootPassword)
        } else {
            let dbContainerId = await checkIfDatabaseModuleExists(coin, network)
            const commandLine = "docker exec "+dbContainerId+" mariadb-admin -u root -p"

            while (!dbRootPassword){
                let messageLine = 'The password for the root user of mariadb is needed in order to create the database container and/or adding new users. What password do you want to set?'
                if (dbContainerId){
                    messageLine = 'Please, type the password for the root user of mariadb to add new users'
                }
                
                let prompt = new Password({
                    name: 'password',
                    message: messageLine
                })
                
                try {
                    let answer = await prompt.run()
                    
                    if (dbContainerId){
                        const { stdout, stderr } = await execAsync(commandLine+answer+" ping")
                        if (stdout.includes('mysqld is alive')) {
                            dbRootPassword = answer
                            resolve(answer)
                        } else {
                            console.log("❌ Wrong password, please try again");
                        }
                    } else {
                        dbRootPassword = answer
                        resolve(answer)
                    }
                } catch (err){
                    console.log("An error has ocurred asking for database password")
                    reject(err)                 
                }
            }
        }
    })
    
}

async function buildDatabaseModule(coin, network){
    return new Promise(async (resolve,reject)=>{
        if (!(await checkIfDatabaseModuleExists(coin, network))){
            console.log("Installing mariadb database...")
        
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
                if (coin && network){
                    await addContainerToNetwork(DB_MODULE_NAME, coin, network)
                    await statusChanged()
                }
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
                    case XChainService.XCHAIN_DECODER:
                        if (("DECODER_PORT" in environmentVariables) && ("DECODER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["DECODER_PORT"]+":"+environmentVariables["DECODER_API_PORT"]
                        }
                        volumeLine = 
                            "-v "+environmentVariables["DECODER_BOOTSTRAP_VOLUME"]+":/bootstrap/xchain-decoder "
                        break
                    case XChainService.XCHAIN_ENCODER:
                        if (("ENCODER_PORT" in environmentVariables) && ("ENCODER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["ENCODER_PORT"]+":"+environmentVariables["ENCODER_API_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_UTXO_TRACKER:
                        if (("UTXO_TRACKER_PORT" in environmentVariables) && ("UTXO_TRACKER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["UTXO_TRACKER_PORT"]+":"+environmentVariables["UTXO_TRACKER_API_PORT"]
                        }
                        
                        volumeLine = 
                            "-v "+module+SEP+coin+"-"+network+"-data:/data/xchain-utxo-tracker "
                            +"-v "+environmentVariables["UTXO_TRACKER_BOOTSTRAP_VOLUME"]+":/bootstrap/xchain-utxo-tracker "
                        
                        break
                    case XChainService.XCHAIN_INDEXER:
                        if (("INDEXER_PORT" in environmentVariables) && ("INDEXER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["INDEXER_PORT"]+":"+environmentVariables["INDEXER_API_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_EXPLORER:
                        if (("EXPLORER_PORT" in environmentVariables) && ("EXPLORER_API_PORT" in environmentVariables)){
                            portLine = "-p "+environmentVariables["EXPLORER_PORT"]+":"+environmentVariables["EXPLORER_API_PORT"]
                        }
                        break
                    case XChainService.XCHAIN_REGTEST_MINER:
                        if ("REGTEST_MINER_PORT" in environmentVariables){
                            portLine = "-p "+environmentVariables["REGTEST_MINER_PORT"]+":"+environmentVariables["REGTEST_MINER_API_PORT"]
                        }
                        break
                    case HUB_MODULE_NAME:
                        coin = ""
                        network = ""
                        portLine = "-p "+environmentVariables["HUB_PORT"]+":"+environmentVariables["HUB_PORT"]
                        break
                    case EXPLORER_MODULE_NAME:
                        coin = ""
                        network = ""
                        portLine = 
                            "-p "+environmentVariables["EXPLORER_PORT_HTTP"]+":"+environmentVariables["EXPLORER_API_PORT_HTTP"]
                            +" -p "+environmentVariables["EXPLORER_PORT_HTTPS"]+":"+environmentVariables["EXPLORER_API_PORT_HTTPS"]
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
                    +'--network '+getDockerNetwork(coin, network)+' '
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
            reject("module doesn't have an url")
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
            //Remove the "v" at the start of the version
            if (version.startsWith("v")){
                version = version.substring(1)
            }
            
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
            resolve(true)
        } else if (coin == Coin.LITECOIN) {
            await gitHubDownloader.downloadRepoVersion("litecoin-project", "litecoin", version, {outputPath:cryptoNodesDir+"/litecoin"})
            resolve(true)
        } else {
            reject("There's no support for "+coin+" in "+network+" network yet")
        }
    })
}

async function statusChanged(){
    statusUpdated = false
    await updateHub()
    await updateExplorer()
}

async function getStatus(coin, network, printStatus = false){
    return new Promise(async (resolve, reject) => {
        if (statusUpdated){
            if (printStatus){
                console.log(lastPrintedStatus)
            }
            resolve(lastStatus)
        } else {
            lastPrintedStatus = ""
            await loadInstalledModules(coin, network)
            
            let coins = Object.keys(installedModules)
            
            if (coins.length > 0){
                //if (printStatus){console.log("Modules installed:")}
                
                for (let nextCoin in installedModules) {
                    if (!((NODE_MODULE_NAME + SEP + nextCoin) in remoteModuleVersions)) {
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
                                        lastPrintedStatus = lastPrintedStatus +
                                            "\x1b[37m["+(nextCoin+" - "+nextCoinNetwork).toUpperCase()+"]\x1b[37m\n"
                                        titlePrinted = true
                                    }
                
                                    let moduleRemoteVersion = "-"
                                    try {
                                        if (nextCoinNetworkModule == NODE_MODULE_NAME) {
                                            moduleRemoteVersion = remoteModuleVersions[nextCoinNetworkModule + SEP + nextCoin]["tag_name"].substring(1)
                                        } else {
                                            moduleRemoteVersion = remoteModuleVersions[nextCoinNetworkModule]
                                        }
                                        
                                        nextCoinNetworkModules[nextCoinNetworkModule]["remote_version"] = moduleRemoteVersion
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
                                        
                                        nextCoinNetworkModules[nextCoinNetworkModule]["local_version"] = moduleLocalVersion
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
                                        
                                        nextCoinNetworkModules[nextCoinNetworkModule]["container_version"] = moduleContainerVersion
                                    } catch (e) {
                                        //Nothing yet
                                    }
                                        
                                    let versionString = " {remote:" + moduleRemoteVersion + ", local:" + moduleLocalVersion + ", container:" + moduleContainerVersion+"}"


                                    if (containerStatus["State"]["Status"] == "Exited") {
                                        lastPrintedStatus = lastPrintedStatus +
                                            " \x1b[31m" + nextCoinNetworkModule + " (" + containerStatus["State"]["Status"] + ")\x1b[37m " + versionString + "\n"
                                    } else {
                                        lastPrintedStatus = lastPrintedStatus +
                                            " \x1b[32m" + nextCoinNetworkModule + " (" + containerStatus["State"]["Status"] + ")\x1b[37m " + versionString + "\n"
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
                
                lastPrintedStatus = lastPrintedStatus + "\n"
                
                if (printStatus){
                    console.log(lastPrintedStatus)
                }
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

async function uninstallModule(coin, network, module){
    return new Promise(async (resolve, reject) => {
        let modulesStatus = await getStatus(null, null, false)
        if (module != DB_MODULE_NAME){//This is to prevent the removing of data
            let moduleStatus = modulesStatus?.[(coin??"")]?.[network??""]?.[module]
            if (moduleStatus !== undefined){
                console.log("Uninstalling "+module+" ("+coin+"/"+network+")")
                try {
                    if (moduleStatus["status"]["State"]["Status"] != "exited"){
                        await killContainer(moduleStatus["container_id"])
                    }
                    await removeContainer(moduleStatus["container_id"])
                    let removedModuleContainerId = await db.removeModuleContainer(module, coin, network)
                    
                    if (removedModuleContainerId){
                        resolve(removedModuleContainerId)
                    } else {
                        reject("There was a problem trying to remove a container from the database")
                    }
                } catch (err){
                    reject("There was a problem trying to kill a container")
                }
            } else {
                //If the module doesn't have status is because is missing
                resolve(true)
            }
        } else {
            reject("The database must be manually removed")
        }
    })
}

async function installModule(coin, network, module, remoteUpdate=false, overwrite_container_id=null, onlyExecution=false){
    return new Promise(async (resolve, reject) => {
        if (coin == ""){coin = null};
        if (network == ""){network = null};
    
        if (module == NODE_MODULE_NAME) {
            let containerNodeVersion = lastStatus?.coin?.network?.module?.["container_version"] ?? null
            
            //If there's no container version it's assumed that the node is not installed yet
            if (!containerNodeVersion || remoteUpdate){
                let localNodeVersion = null
                try {
                    localNodeVersion = await getLocalNodeVersion(coin, network)
                } catch (err) {
                    //Nothing localNodeVersion will be null
                }

                if (localNodeVersion == null) {
                    try {
                        let remoteNodeVersion = remoteModuleVersions[NODE_MODULE_NAME + SEP + coin]["tag_name"]
                        await getCryptoNode(coin, network, remoteNodeVersion)
                    } catch (err) {
                        reject(err)
                    }
                }

                await buildCryptoNode(coin, network)
                await statusChanged()
                resolve(true)
            } else {
                resolve(false)
            }
        } else if (module == DB_MODULE_NAME) {
            try {
                await buildDatabaseModule(coin, network)
                await statusChanged()                 
                resolve(true)
            } catch (err){
                reject(err)
            }
        } else if (module == EXPLORER_MODULE_NAME) {
            try {
                await installExplorerModule()
                await statusChanged()   
                resolve(true)
            } catch (err){
                reject(err)
            }
        } else {
            let containerNodeVersion = lastStatus?.coin?.network?.module?.["container_version"] ?? null
            
            if (!containerNodeVersion || remoteUpdate){
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
                    
                    if ((module == XChainService.XCHAIN_DECODER) || (module == XChainService.XCHAIN_INDEXER)){
                        await setDatabaseParameters()
                    }
                    
                    if (!onlyExecution){
                        await statusChanged()
                    }
                    resolve(containerId)
                } catch (err){
                    reject(err)
                }
            } else {
                resolve(false)
            }
        }
        
        reject("Can't install the module, it doesn't exist")
    })
}

async function updateHub(){
    //Updating xchain-explorer networks
    let installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
    let hubContainerId = await db.getModuleContainer(HUB_MODULE_NAME, "", "")
        
    if (hubContainerId){   
        for (let nextCoin in installedCoinsAndNetworks){
            for (let nextNetworkIndex in installedCoinsAndNetworks[nextCoin]){
                let nextNetwork = installedCoinsAndNetworks[nextCoin][nextNetworkIndex]
                
                try{
                    await addContainerToNetwork(HUB_MODULE_NAME, nextCoin, nextNetwork)
                } catch (err){
                    console.log("There was an error trying to connect the xchain-hub to the "+nextCoin+"/"+nextNetwork+" network")
                }
            }
        }
        
        await updateHubOrExplorer("xchain-hub")
    }
    
    return true
}

async function updateExplorer(){
    //Updating xchain-explorer networks
    let explorerStatus = lastStatus?.[""]?.[""]?.[EXPLORER_MODULE_NAME]
    
    if (explorerStatus !== undefined){
        let installedCoinsAndNetworks = await getInstalledCoinsAndNetworks()
        let explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")
            
        if (explorerContainerId){   
            for (let nextCoin in installedCoinsAndNetworks){
                for (let nextNetworkIndex in installedCoinsAndNetworks[nextCoin]){
                    let nextNetwork = installedCoinsAndNetworks[nextCoin][nextNetworkIndex]
                    
                    try{
                        await addContainerToNetwork(EXPLORER_MODULE_NAME, nextCoin, nextNetwork)
                    } catch (err){
                        
                    
                        console.log("There was an error trying to connect the xchain-explorer to the "+nextCoin+"/"+nextNetwork+" network")
                    }
                }
            }
            
            //await updateHubOrExplorer("xchain-explorer")
        }
    }
    
    return true 
}

async function updateHubOrExplorer(module){
    return new Promise(async (resolve, reject) => {
        if (["xchain-hub","xchain-explorer"].includes(module)){
            //console.log("Updating "+module+"...")
            let defaultConfig = await getDefaultConfig(module, null, null)
            let moduleConnector = null
            
            if (module == "xchain-hub"){
                moduleConnector = new HubConnector("127.0.0.1", defaultConfig["HUB_PORT"])
            } else {
                moduleConnector = new ExplorerConnector("127.0.0.1", defaultConfig["EXPLORER_PORT"])
            }
            
            await getStatus(null, null, false)
            
            if (statusUpdated){
                let jsonConfig = {}
                
                if (module == "xchain-explorer"){
                    jsonConfig["configs"] = []
                    jsonConfig = jsonConfig["configs"]
                }
                
                for (let nextCoin in lastStatus){
                    for (let nextNetwork in lastStatus[nextCoin]){
                        let defaultConfigCoinNetwork = await getDefaultConfig("", nextCoin, nextNetwork)
                        
                        let nextConfigObject = null
                        if (module == "xchain-explorer"){
                            nextConfigObject = {
                                "coin": nextCoin,
                                "network": nextNetwork
                            }
                            jsonConfig.push(nextConfigObject)
                        }
                        
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
                                case XChainService.XCHAIN_DECODER:
                                    config = {
                                        "host":defaultConfigCoinNetwork["DECODER_URL"],
                                        "port":defaultConfigCoinNetwork["DECODER_API_PORT"],
                                        "server_port":defaultConfigCoinNetwork["DECODER_PORT"],
                                        "db_host":defaultConfigCoinNetwork["DECODER_DB_HOST"],
                                        "db_port":defaultConfigCoinNetwork["DECODER_DB_PORT"],
                                        "name":defaultConfigCoinNetwork["DECODER_DB_NAME"],
                                        "user":defaultConfigCoinNetwork["DECODER_DB_USER"],
                                        "pass":defaultConfigCoinNetwork["DECODER_DB_PASS"]
                                    }
                                    break
                                case XChainService.XCHAIN_ENCODER:
                                    config = {
                                        "host":defaultConfigCoinNetwork["ENCODER_URL"],
                                        "port":defaultConfigCoinNetwork["ENCODER_API_PORT"],
                                        "server_port":defaultConfigCoinNetwork["ENCODER_PORT"]
                                    }
                                    break
                                case XChainService.XCHAIN_INDEXER:
                                    config = {
                                        "host":defaultConfigCoinNetwork["INDEXER_HOST"],
                                        "port":defaultConfigCoinNetwork["INDEXER_API_PORT"],
                                        "server_port":defaultConfigCoinNetwork["INDEXER_PORT"],
                                        "db_host":defaultConfigCoinNetwork["INDEXER_DB_HOST"],
                                        "db_port":defaultConfigCoinNetwork["INDEXER_DB_PORT"],
                                        "name":defaultConfigCoinNetwork["INDEXER_DB_NAME"],
                                        "user":defaultConfigCoinNetwork["INDEXER_DB_USER"],
                                        "pass":defaultConfigCoinNetwork["INDEXER_DB_PASS"]
                                    }
                                    break
                                case XChainService.XCHAIN_EXPLORER:
                                    config = {
                                        "host":defaultConfigCoinNetwork["EXPLORER_HOST"],
                                        "port":defaultConfigCoinNetwork["EXPLORER_API_PORT"],
                                        "server_port":defaultConfigCoinNetwork["EXPLORER_PORT"],
                                        "name":defaultConfigCoinNetwork["EXPLORER_DB_NAME"],
                                        "user":defaultConfigCoinNetwork["EXPLORER_DB_USER"],
                                        "pass":defaultConfigCoinNetwork["EXPLORER_DB_PASS"]
                                    }
                                    break
                                case XChainService.XCHAIN_UTXO_TRACKER:
                                    config = {
                                        "host":defaultConfigCoinNetwork["UTXO_TRACKER_URL"],
                                        "port":defaultConfigCoinNetwork["UTXO_TRACKER_API_PORT"],
                                        "server_port":defaultConfigCoinNetwork["UTXO_TRACKER_PORT"]
                                    }
                                    break
                                case XChainService.XCHAIN_REGTEST_MINER:
                                    config = {
                                        "host":defaultConfigCoinNetwork["REGTEST_MINER_URL"],
                                        "port":defaultConfigCoinNetwork["REGTEST_MINER_API_PORT"],
                                        "server_port":defaultConfigCoinNetwork["REGTEST_MINER_PORT"]
                                    }
                                    break   
                            }
                            
                            if (config != null){
                                if (module == "xchain-explorer"){
                                    nextConfigObject[nextModule] = config
                                } else {
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
                }
                
                if (module == "xchain-explorer"){
                    try {
                        let explorerContainerId = await db.getModuleContainer(EXPLORER_MODULE_NAME, "", "")
                        await stringToDockerContainerFile(explorerContainerId, JSON.stringify(jsonConfig), "/XChainExplorer/src/config.json")
                    } catch (err) {
                        reject("There was a problem trying to update a config in the "+module+" module")
                    }
                } else {
                    let hubUpdated = false
                    let tries = 10
                    while (!hubUpdated){
                        try {
                            hubUpdated = await moduleConnector.updateConfig(jsonConfig)
                        } catch (err){
                            //console.error(err)
                        }
                        
                        tries--
                        
                        if (tries <= 0){
                            reject("There was a problem trying to update a config in the "+module+" module")
                            break
                        }
                        
                        if (!hubUpdated){
                            console.log("There was a problem trying to update a config in the "+module+" module. Trying again in 3 seconds...")
                            await sleep(3000)
                        }
                    }
                }
                
                resolve(true)
            } else {
                reject("The status is not updated")
            }
        } else {
            reject("Only the xchain-hub or the xchain-explorer could be updated")
        }
    })
}

async function installHubModule(){
    return new Promise(async (resolve, reject) => {
        let defaultConfig = await getDefaultConfig(HUB_MODULE_NAME, null, null)
        
        console.log("Checking if xchain-hub module is running")
        let hubConnector = new HubConnector(defaultConfig["HUB_HOST"], defaultConfig["HUB_PORT"])
        
        let pingHub = await hubConnector.ping()
        
        if (pingHub){
            resolve(true)
            return true //The hub is already installed and running
        } else {
            console.log("Checking if xchain-hub module is installed")
            if (statusUpdated){
                let hubModuleHasStatus = lastStatus?.[""]?.[""]?.[HUB_MODULE_NAME]
    
                if (hubModuleHasStatus !== undefined){
                    let hubModuleStatus = hubModuleHasStatus["status"]["State"]["Status"]
                    
                    if (hubModuleStatus == "exited"){
                        console.log("The hub module container status is 'exited'. Restarting it...")
                        let hubContainerId = hubModuleHasStatus["container_id"]
                        let hubWasRestarted = await dockerManager.restartContainer(hubContainerId)
                        
                        if (hubWasRestarted !== true){
                            reject(false)
                            return false
                        }
                    }
                
                    resolve(true)
                    return true
                }
            }
            
            //TODO: Checking if xchain-hub module is installed
            console.log("Downloading xchain-hub...")
            await cloneGit(HUB_MODULE_NAME, true)
            console.log("Installing xchain-hub module...")
            await buildAndUp(HUB_MODULE_NAME, null, null)
            await getStatus(null, null, false)
            
            console.log("Waiting for the xchain-hub to respond")
            
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

function filterCommandParameters(branch, modules, coins, networks){
    let servicesList = {}
    let addExplorer = false
    
    if (coins && coins != "all"){
        coins = [coins]
    } else {
        coins = Object.values(Coin)
    }
    
    if (networks && networks != "all"){
        networks = [networks]
    } else {
        networks = Object.values(Network)
    }
    
    if (modules == "all"){
        modules = Object.values(XChainService) 
        modules.push(NODE_MODULE_NAME)
        addExplorer = true
    } else if (modules == "explorer"){
        addExplorer = true
        coins = [] //only explorer will be added
        //modules = [EXPLORER_MODULE_NAME]
    } else if (modules == "node"){
        modules = [NODE_MODULE_NAME]
    } else if (modules){
        modules = [modules]
    }
    
    if (addExplorer){
        servicesList[""] = {}
        servicesList[""][""] = []
        servicesList[""][""].push(EXPLORER_MODULE_NAME)
    }
    
    for (let nextCoin of coins){
        if (!(nextCoin in servicesList)){
            servicesList[nextCoin] = {}
        }
    
        for (let nextNetwork of networks){
            if (!(nextNetwork in servicesList[nextCoin])){
                servicesList[nextCoin][nextNetwork] = []
            }
    
            for (let nextModule of modules){
                if (!REGTEST_MODULES.includes(nextModule) || (nextNetwork == Network.REGTEST)){
                    servicesList[nextCoin][nextNetwork].push(nextModule)
                }
            }
        }
    }
    
    return servicesList
}

async function installModules(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            if ((nextCoin) && (nextNetwork)){
                await createDockerNetwork(nextCoin, nextNetwork)
                await buildDatabaseModule(nextCoin, nextNetwork)
            }
            
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                await installModule(nextCoin, nextNetwork, nextModule)
            }
        }
    }
    
    return true
}

async function updateModules(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                //Get module container id
                let moduleContainerId = await db.getModuleContainer(
                    nextModule, 
                    nextCoin, 
                    nextNetwork
                )
            
                //Get the last version from git
                await cloneGit(nextModule, true, false)
                
                //Install module and remove old container
                await installModule(nextCoin, nextNetwork, nextModule, false, moduleContainerId)
            }
        }
    }
    
    return true
}

async function uninstallModules(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    await uninstallModule(nextCoin, nextNetwork, nextModule)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    return true
}

async function logModules(servicesList, follow=true){
    let moduleContainerIds = []
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    let moduleContainerId = await db.getModuleContainer(
                        nextModule, 
                        nextCoin, 
                        nextNetwork
                    )
                    moduleContainerIds.push({name:getDockerContainerImageName(nextModule, nextCoin, nextNetwork),id:moduleContainerId})
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    await dockerManager.startDockerMonitor(moduleContainerIds, follow)
    return true
}

async function restartModules(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    let moduleContainerId = await db.getModuleContainer(
                        nextModule, 
                        nextCoin, 
                        nextNetwork
                    )
                    await dockerManager.restartContainer(moduleContainerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    return true
}

async function stopModules(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    let moduleContainerId = await db.getModuleContainer(
                        nextModule, 
                        nextCoin, 
                        nextNetwork
                    )
                    await dockerManager.stopContainer(moduleContainerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    return true
}

async function startModules(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    let moduleContainerId = await db.getModuleContainer(
                        nextModule, 
                        nextCoin, 
                        nextNetwork
                    )
                    await dockerManager.startContainer(moduleContainerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    return true
}

async function execModules(servicesList, command){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    let moduleContainerId = await db.getModuleContainer(
                        nextModule, 
                        nextCoin, 
                        nextNetwork
                    )
                    let execStdOut = await dockerManager.execContainer(moduleContainerId, command)
                    console.log(execStdOut)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    return true
}

async function shellModule(servicesList){
    for (let nextCoin in servicesList){
        for (let nextNetwork in servicesList[nextCoin]){
            for (let nextModule of servicesList[nextCoin][nextNetwork]){
                try {
                    let moduleContainerId = await db.getModuleContainer(
                        nextModule, 
                        nextCoin, 
                        nextNetwork
                    )
                    await dockerManager.shellContainer(moduleContainerId)
                    return true
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    
    return true
}


async function installExplorerModule(){
    return new Promise(async (resolve, reject) => {
        let defaultConfig = await getDefaultConfig(EXPLORER_MODULE_NAME, null, null)
        
        console.log("Checking if xchain-explorer module is running")
        let explorerConnector = new ExplorerConnector(defaultConfig["EXPLORER_HOST"], defaultConfig["EXPLORER_PORT"])
        
        let pingExplorer = await explorerConnector.ping()
        
        if (pingExplorer){
            resolve(true)
            return true //The explorer is already installed and running
        } else {
            console.log("Checking if xchain-explorer module is installed")
            if (statusUpdated){
                let explorerModuleHasStatus = lastStatus?.[""]?.[""]?.[EXPLORER_MODULE_NAME]
    
                if (explorerModuleHasStatus !== undefined){
                    resolve(true)
                    return true
                }
            }
            
            console.log("Downloading xchain-explorer...")
            await cloneGit(EXPLORER_MODULE_NAME, true)
            console.log("Installing xchain-explorer module...")
            await buildAndUp(EXPLORER_MODULE_NAME, null, null)
            await getStatus(null, null, false)
            
            console.log("Waiting for the xchain-explorer to respond")
            
            let tries = 10
            
            while (tries > 0){
                pingExplorer = await explorerConnector.ping()
                
                if (pingExplorer){
                    //pass data to the explorer
                    await updateExplorer()
                
                    resolve(true)
                    return true
                } else {
                    await sleep(1000)
                }
                
                tries = tries - 1
            }
            
            reject("Couldn't install the explorer module")
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
        //console.log(err)
    }

    if (localNodeVersion == null) {
        if (!(NODE_MODULE_NAME + SEP + coin in remoteModuleVersions)){
            await checkRemoteNodeVersion(coin)
        }
    
        let remoteNodeVersion = remoteModuleVersions[NODE_MODULE_NAME + SEP + coin]["tag_name"]
        
        if (remoteNodeVersion != null){
            await getCryptoNode(coin, network, remoteNodeVersion)
        } else {
            throw Error("There is no valid version to download for the $coin/$network node")
        }
    }
    await buildCryptoNode(coin, network)
    
    console.log("Downloading xchain-encoder...")
    //let localXchainEncoderVersion = await getLocalModuleVersion(XChainService.XCHAIN_ENCODER)
    //let remoteXchainEncoderVersion = await getRemoteModuleVersion(XChainService.XCHAIN_ENCODER)
    //let containerXchainEncoderVersion = await getContainerModuleVersion(XChainService.XCHAIN_ENCODER)
    
    await cloneGit(XChainService.XCHAIN_ENCODER, true)
    console.log("Building xchain-encoder container...")
    await buildAndUp(XChainService.XCHAIN_ENCODER, coin, network)
    
    console.log("Downloading xchain-decoder...")
    await cloneGit(XChainService.XCHAIN_DECODER, true)
    console.log("Building xchain-decoder container...")
    await buildAndUp(XChainService.XCHAIN_DECODER, coin, network)
    
    console.log("Downloading xchain-utxo-tracker...")
    await cloneGit(XChainService.XCHAIN_UTXO_TRACKER, true)
    console.log("Building xchain-utxo-tracker...")
    await buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    
    if (network == Network.REGTEST){
        console.log("Downloading xchain-regtest-miner...")
        await cloneGit(XChainService.XCHAIN_REGTEST_MINER, true)
        console.log("Building xchain-regtest_miner...")
        await buildAndUp(XChainService.XCHAIN_REGTEST_MINER, coin, network)
    }
    
    console.log("Downloading xchain-indexer...")
    await cloneGit(XChainService.XCHAIN_INDEXER, true)
    console.log("Building xchain-indexer...")
    await buildAndUp(XChainService.XCHAIN_INDEXER, coin, network)
    
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
        
            let allModules = Object.values(XChainService)
            
            //Remove e2eTest module from all networks, TODO: get the list of installable modules
            let e2eTestIndex = allModules.indexOf(XChainService.XCHAIN_E2E_TEST)
                
            if (e2eTestIndex >= 0){
                allModules.splice(e2eTestIndex, 1)
            }
            
            //Leave regtest miner only for REGTEST network
            if (network != Network.REGTEST){
                let regtestMinerIndex = allModules.indexOf(XChainService.XCHAIN_REGTEST_MINER)
                
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
            message: 'In which ('+coin+'/'+network+') module do you want to perform actions?',
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
                        let containerId = await installModule(coin, network, XChainService.XCHAIN_E2E_TEST, true)
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
                            remoteModuleVersion = await remoteModuleVersions[actionModules[moduleAnswer]["value"] + SEP + coin]["version"]
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
                                    moduleActions.push({ name: "Update local version", value: "update locale version" })
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
                            
                            if (actionModules[moduleAnswer]["value"] == XChainService.XCHAIN_UTXO_TRACKER){
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
                    let separatedImageName = imageName.split(SEP)
                    
                    if ((separatedImageName.length == 1)
                        &&(separatedImageName[0] == DB_MODULE_NAME)){
                        
                    } else if (separatedImageName.length == 3){//coin + network + node
                        //let {coin,network} = stringToNetwork(separatedImageName[0])
                        //coin = Coin[coin]
                        //network = Network[network]
                        coin = Coin[separatedImageName[0]]
                        network = Coin[separatedImageName[1]]
                        
                        if ((coin != null) && (network != null)){
                            let module = stringToXChainService(separatedImageName[2])
                            
                            if (module != null){
                                module = XChainService[module]
                            } else {
                                if (separatedImageName[2] == NODE_MODULE_NAME){
                                    module = NODE_MODULE_NAME
                                }
                            }
                            
                            if (module != null){
                                let moduleDb = await db.getModuleContainer(module, coin, network)
                                
                                if (moduleDb == null){//It's not in the database
                                    await db.insertModuleContainer(module, coin, network, nextContainer.ID)
                                    console.log("Added "+coin+"-"+network+SEP+module+" ("+nextContainer.ID+")")
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

function xchainExplorerInterface(){
    return new Promise(async (resolve, reject) => {
        
    
    
        let explorerActionsPrompt = new Select({
            name: "explorerAction",
            message: "Select an action to take with the xchain-explorer",
            choices: [
                {name:'Install/Configure database',value:'configure_database'}
            ]
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
                } else if (answer == "xchain-explorer"){
                    resolve({
                        menuFunction:xchainExplorerInterface, 
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
        ).catch(error=>{
            console.log("An error has ocurred in Enquirer:",error)
        })
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

async function preCheck(){
    try {
        console.log("Checking if Docker is installed")
        await checkDockerInstalledAndReachable()
        } catch(err){
        throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
    }
    
    console.log("Checking/Creating directories")
    createDirectories()
    console.log("Checking/Creating database")
    await db.createDatabase()
    console.log("Getting all remote project versions")
    await checkAllRemoteVersions()
    console.log("Getting modules status")
    await getStatus(null, null, false)
    
    try {
        await createDockerNetwork("", "")
    } catch(err){
        throw new Error("There was an error trying to create the base xchain network")
    }
    
    try {
    
        console.log("Checking/Installing hub module")
        await installHubModule()
    } catch (err) {
        throw new Error("There was an error trying to install the hub module")
    }
    
    try{
        await updateHub() //Force a hub update
        await updateExplorer() //Force a explorer update
    } catch (err){
        console.log(err)
        throw new Error("There was an error trying to update the hub module")
    }
    
    return true
}



// Function to handle parsing in the command and command line arguments and process
async function parse(){
    const program = new Command();

    //this will be executed only if the command inserted by the user was valid
    program.hook('preAction', async (thisCommand, actionCommand) => {
        //try{
            console.log("Checking xchain-node structure")
            await preCheck();
        //} catch (err){
        //  console.log("There was an error checking the xchain-node structure")
        //    console.log(err)              
        //}
    });

    // No Parameters given (xchain-node)
    program
        .name('xchain-node')
        .version(version, '-v, --version', 'Shows xchain-node version')
        .option('-i, --interactive', 'Interactive mode')
        .option('--no-bootstrap', 'Do not download bootstrap files (full parse)')
        .option('--no-explorer', 'Do not install xchain-explorer')
        .action(async(options) => {
            if (options.interactive){
                await preCheck();
                return startInterface();
            }
            // Shows help when there is no parameters
            program.help(); 
        });

    // Install
    program
        .command('install')
        .description('Installs XChain services')
        .argument('<branch>',  '(master, develop)')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (branch, service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await installModules(serviceList)
            return process.exit(0)
        });

    // Uninstall
    program
        .command('uninstall')
        .description('Uninstall XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await uninstallModules(serviceList)
            return process.exit(0)
        });

    // Update
    program
        .command('update')
        .description('Update XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await updateModules(serviceList)
            return process.exit(0)
        });

    // Process List (ps)
    program
        .command('ps')
        .description('List installed XChain services and status')
        .action(async (options) => {
            await getStatus(null, null, true)
            return process.exit(0)
        });

    // Start
    program
        .command('start')
        .description('Start XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await startModules(serviceList)
            return process.exit(0)
        });

    // Stop
    program
        .command('stop')
        .description('Stop XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await stopModules(serviceList)
            return process.exit(0)
        });

    // Restart
    program
        .command('restart')
        .description('Restart XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await restartModules(serviceList)
            return process.exit(0)
        });

    // Tail Logs
    program
        .command('tail')
        .description('Tail XChain service logs')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await logModules(serviceList, false)
            return process.exit(0)
        });

    // Full Logs
    program
        .command('logs')
        .description('Display full XChain service logs')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await logModules(serviceList)
            return process.exit(0)
        });

    // Execute
    program
        .command('exec')
        .description('Execute command on XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .argument('<command>', 'The shell command to execute')
        .action(async (service, chain, network, command) => {
            serviceList = filterCommandParameters(null, service, chain, network)
            await execModules(serviceList, command)
            return process.exit(0)
            // coming soon
        });

    // Shell
    program
        .command('shell')
        .description('Shell into a XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .action(async (service, chain, network) => {
            if ((service == "all") || (chain == "all") || (network == "all")){
                console.log("The shell command can't be used for multiple containers, 'all' is invalid")
                return process.exit(0)
            }
            
            serviceList = filterCommandParameters(null, service, chain, network)
            await shellModule(serviceList)
            return process.exit(0)
        });

    // Rollback
    program
        .command('rollback')
        .description('Rollback XChain service to a set block_index')
        .argument('<block_index>', 'The index of the last known good block')
        .argument('<service>',     '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, all)')
        .argument('<chain>',       '(bitcoin, litecoin, dogecoin)')
        .argument('<network>',     '(mainnet, testnet, regtest)')
        .action(async (block_index, service, chain, network) => {
            // coming soon
        });

    // Bootstrap
    program
        .command('bootstrap')
        .description('Create / Restore XChain service bootstraps')
        .argument('<action>',  '(create, restore)')
        .argument('<service>', '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-hub)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .addHelpText('after', `
Notes:
    Bootstrap files are written to and restored from ~/xchain-node/bootstraps/<chain>/<network>/<service>/bootstrap-<block_index>.tgz
    bootstrap create generates a bootstrap file in the above directory
    bootstrap restore downloads a bootstrap file to the above directory and restores it`)
        .action(async (action, service, chain, network) => {
            if (action == "create"){
                await makeBootstrap(chain, network, service)
            } else {
                await restoreBootstrapInterface(chain, network, service)
            }
        });



    program.parse(process.argv);
}

parse()