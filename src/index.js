const dotenv = require('dotenv')
dotenv.config()

const { exec } = require('child_process')
const https = require('https');
const fs = require("fs");
const readline = require('readline')
const path = require("path")
const LevelUpStore = require('./LevelUpDb.js')
const mariadb = require('mariadb')

//Console interface
const { prompt, Select, Password } = require('enquirer');


const NODE_PREFIX = process.env.NODE_PREFIX
const DB_NAME = (process.env.DB_NAME == null?"xchain_node":process.env.DB_NAME)

const NODE_MODULE_NAME = "node"
const DB_MODULE_NAME = "db"

const XChainModule = {
	XCHAIN_ENCODER: "xchain-encoder",
	XCHAIN_DECODER: "xchain-decoder",
	XCHAIN_ADDRESS_INDEXER: "xchain-address-indexer",
	XCHAIN_REGTEST_MINER: "xchain-regtest-miner"//,
	//XCHAIN_EXPLORER: "xchain-explorer"
}

const moduleDir = path.join(__dirname,"..","modules")
const cryptoNodesDir = path.join(__dirname,"..","crypto_nodes")
const dataDir = path.join(__dirname,"..","data")
const configDir = path.join(__dirname,"..","config")


const dbRootPasswords = {}

var installedModules = {}

/*const modulesUrls = {
	"xchain-encoder": "https://github.com/XChain-platform/xchain-encoder",
	"xchain-decoder": "https://github.com/XChain-platform/xchain-decoder",
	"xchain-address-indexer": "https://github.com/XChain-platform/xchain-address-indexer",
	"xchain-explorer": "https://github.com/XChain-platform/xchain-explorer",
	"xchain-regtest-miner": "https://github.com/XChain-platform/xchain-regtest-miner"
}*/

const modulesUrls = {
	"xchain-encoder": "git@github.com:XChain-platform/xchain-encoder.git",
	"xchain-decoder": "git@github.com:XChain-platform/xchain-decoder.git",
	"xchain-address-indexer": "git@github.com:XChain-platform/xchain-address-indexer.git",
	"xchain-explorer": "git@github.com:XChain-platform/xchain-explorer.git",
	"xchain-regtest-miner": "git@github.com:XChain-platform/xchain-regtest-miner.git"
}

const Coin = {
	BITCOIN: "bitcoin",
	DOGECOIN: "dogecoin",
	LITECOIN: "litecoin"
}

const Network = {
	MAINNET: "mainnet",
	TESTNET: "testnet",
	REGTEST: "regtest"
}

//Initializing db
const db = new LevelUpStore(DB_NAME, dataDir)

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

function checkIfModuleExists(module){
	let moduleDir = getModuleDir(module)
	
	result = fs.existsSync(moduleDir)
		&& fs.existsSync(moduleDir+"/Dockerfile")
		&& fs.existsSync(moduleDir+"/src")
	
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

function getCryptoNodeDir(coin, network){
	return cryptoNodesDir+"/"+Coin[coin]
}

function removeModuleDir(module){
	let moduleDir = getModuleDir(module)
	
	fs.rmSync(moduleDir, {recursive:true})
}

function moduleDirExists(module){
	return fs.existsSync(getModuleDir(module))
}

function getDockerContainerImageNamePrefix(module, coin, network){
	if (module == DB_MODULE_NAME){
		return NODE_PREFIX
	} else {
		return NODE_PREFIX + "_" + coin + "-" + network
	}
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
			exec('docker network connect '+getDockerNetwork(coin, network)+' '+moduleContainerId+'', (error, stdout, stderr) => {
				if (error){
					reject(error)
				} else {
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
	let defaultValues = {
		"NETWORK":network,
		"NODE_URL":NODE_MODULE_NAME,
		"NODE_PORT":(network==Network.MAINNET?8332:(network==Network.TESTNET?18332:18444)),
		"NODE_USER":"rpc",
		"NODE_PASSWORD":"rpc",
		"ADDRESS_INDEXER_URL":getDockerContainerImageName(XChainModule.XCHAIN_ADDRESS_INDEXER, coin, network),
		"ADDRESS_INDEXER_API_PORT":3001,
		"DECODER_DB_NAME":"xchain_decoder_"+network,
		"DB_URL":DB_MODULE_NAME,
		//"DB_PORT":3306,
		"DECODER_DB_USER":"xchain_decoder_"+coin+"_"+network,
		"DB_PASSWORD":"xchain_password",
		"DECODER_URL":getDockerContainerImageName(XChainModule.XCHAIN_DECODER, coin, network),
		"DECODER_API_PORT":3002,
		"ENCODER_URL":getDockerContainerImageName(XChainModule.XCHAIN_ENCODER, coin, network),
		"ENCODER_API_PORT":3003
	}
	
	//Read the default config file
	let defaultConfig = {}
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
	
	for (let nextKeyValue in defaultValues){
		if (!(nextKeyValue in defaultConfig)){
			defaultConfig[nextKeyValue] = defaultValues[nextKeyValue]
		}
	}
	
	return defaultConfig
}

async function buildCryptoNode(coin, network){
	return new Promise(async (resolve,reject)=>{
		let defaultConfig = await getDefaultConfig(NODE_MODULE_NAME, coin, network)
		let defaultExposedPort = defaultConfig["NODE_EXPOSED_PORT"]
	
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
				+'--hostname '+NODE_MODULE_NAME+' '
				+'--network '+getDockerNetwork(coin, network)+' '
				+(defaultExposedPort?'-p '+defaultExposedPort+':8332 ':"")
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
					await addUserPasswordToDatabase(XChainModule.XCHAIN_ENCODER, nextCoin, nextNetwork)
				} catch(err) {
					console.log("There was a problem adding de database container to the docker network of "+coin+" "+network+"")
					reject(err)
				}
			}
		}
		
		resolve(true)
	})
}

async function addUserPasswordToDatabase(module, coin, network, inDocker = true){
	return new Promise(async (resolve,reject)=>{
		if (!(coin in dbRootPasswords)){
			await askMariadbRootPassword(coin, network)
		}
		let mariadbRootPassword = dbRootPasswords[coin]//[network]
		
		let moduleContainerId = await db.getModuleContainer(module, coin, network)
		let containerStatus = await getStatusFromContainer(moduleContainerId)
		let dockerNetwork = getDockerNetwork(coin, network)
		let gatewayIp = containerStatus["NetworkSettings"]["Networks"][dockerNetwork]["Gateway"]
		let gatewayIpSplit = gatewayIp.split(".")
		gatewayIp = gatewayIpSplit[0]+"."+gatewayIpSplit[1]+"."+gatewayIpSplit[2]+".0"
		
		let defaultConfig = await getDefaultConfig(module, coin, network)
	
		let databaseName = defaultConfig["DECODER_DB_NAME"]
		let user = defaultConfig["DECODER_DB_USER"]
		let userPassword = defaultConfig["DB_PASSWORD"]
		
		let mariadbUser = "'"+user+"'@'"+gatewayIp+"/255.255.255.0'"
		let query1 = "CREATE USER IF NOT EXISTS "+mariadbUser+" IDENTIFIED BY '"+userPassword+"'"
		let query2 = "CREATE DATABASE IF NOT EXISTS "+databaseName+""
		let query3 = "GRANT ALL PRIVILEGES ON "+databaseName+".* TO "+mariadbUser
		let query4 = "FLUSH PRIVILEGES"
	
		//This means mariadb is inside a docker container, we will execute the queries using docker command
		if (inDocker){
			try {
				await checkIfDatabaseIsReady("root", mariadbRootPassword)
			} catch(err) {
				reject(err)
				return
			}
		
			let mariadbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
			
			let dockerCommand = 'docker exec -i '+mariadbContainerId+' mariadb -u root -p'+mariadbRootPassword+' -e "'
		
			exec(dockerCommand+query1+'"', (error, stdout, stderr) => {
				if (error){
					reject(error)
				} else {
					exec(dockerCommand+query2+'"', (error, stdout, stderr) => {
						if (error){
							reject(error)
						} else {
							exec(dockerCommand+query3+'"', async (error, stdout, stderr) => {
								if (error){
									reject(error)
								} else {
									exec(dockerCommand+query4+'"', async (error, stdout, stderr) => {
										if (error){
											reject(error)
										} else {
											console.log("User "+mariadbUser+" was added to the database")
											resolve(true)
										}
									})
								}
							})
						}
					})
				}
			})
		
		//This means mariadb was not installed by this xchain-node, we will use the root password to add our user
		} else {
			let connectionParams = {
				host: url,
				port: port,
				user: "root",
				password: rootPassword
			}
			
			try {
				let connection = await mariadb.createConnection(connectionParams)
				
				await connection.query(query1)
				await connection.query(query2)
				await connection.query(query3)
				
				console.log("User "+mariadbUser+" was added to the database")
				
				resolve(true)
			} catch (err){
				console.log(err)
				reject(err)
			}
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
			
			//Download the latest mariadb from the hub
			exec('docker pull mariadb:latest ', (error, stdout, stderr) => {
				//Put a new name on the downloaded image
				exec('docker tag mariadb:latest '+container_prefix, (error, stdout, stderr) => {
					// Create the container with docker up
					let dockerCommand = 'docker run -d --hostname mariadb --network '+getDockerNetwork(coin, network)+' '+portLine+' --env MYSQL_ROOT_PASSWORD='+mariadbRootPassword+' '+container_prefix
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
				resolve(true)
			} catch (err){
				console.log(err)
				reject("There was a problem trying to add the db container to the network "+coin+" "+network)
			}
			
		}
	})
}

async function buildAndUp(module, coin, network){
	return new Promise(async (resolve,reject)=>{
		if (checkIfModuleExists(module)){
		
			//Creating the environmentVariables for this specific module
			let environmentVariables = await getDefaultConfig(module, coin, network)
			let environmentVariablesLine = ""
		
			for (let nextEnvironmentVariableKey in environmentVariables){
				let nextEnvironmentVariableValue = environmentVariables[nextEnvironmentVariableKey]
				
				environmentVariablesLine = environmentVariablesLine + ' -e "'+nextEnvironmentVariableKey+'='+nextEnvironmentVariableValue+'"'
			}
		
		
			let moduleDir = getModuleDir(module)
			let container_prefix = getDockerContainerImageName(module, coin, network)// NODE_PREFIX + "_" + coin + "-" + network
	
			console.log("Building image of module "+module+" in "+coin+" "+network)
			exec('docker build . -t '+container_prefix, {cwd:moduleDir}, (error, stdout, stderr) => {
				if (error) {
					console.error(`Error creating Docker image: ${error.message}`);
					return;
				}
				
				let portLine = ""
				switch(module){
					case XChainModule.XCHAIN_DECODER:
						if ("DECODER_PORT" in environmentVariables){
							portLine = "-p "+environmentVariables["DECODER_PORT"]+":3000"
						}
						break
					case XChainModule.XCHAIN_ENCODER:
						if ("ENCODER_PORT" in environmentVariables){
							portLine = "-p "+environmentVariables["ENCODER_PORT"]+":3000"
						}
						break
					case XChainModule.XCHAIN_ADDRESS_INDEXER:
						if ("ADDRESS_INDEXER_PORT" in environmentVariables){
							portLine = "-p "+environmentVariables["ADDRESS_INDEXER_PORT"]+":3000"
						}
						break
					case XChainModule.XCHAIN_REGTEST_MINER:
						if ("REGTEST_MINER_PORT" in environmentVariables){
							portLine = "-p "+environmentVariables["REGTEST_MINER_PORT"]+":3000"
						}
						break	
				}		

				
				// Create the container with docker up
				let dockerCommand = 'docker run -d --network '+getDockerNetwork(coin, network)+' '+environmentVariablesLine+' '+portLine+' -t '+container_prefix
				console.log("Creating container of module "+module+" in "+coin+" "+network)
				exec(dockerCommand, {cwd:moduleDir}, async (error, stdout, stderr) => {
					if (error) {
						reject(`Error creating the container: ${error.message}`);
					}

					//If the response length has length 64, then it is most likely the container id
					let stdoutTrimmed = stdout.trim()
					if (stdoutTrimmed.length == 64){
						let containerId = stdoutTrimmed
						
						if (await db.insertModuleContainer(module, coin, network, containerId)){
							resolve(containerId)
						} else {
							reject("There was a problem trying to store the container's id")
						}
					}
				});
			});
		} else {
			reject("module not found")
		}
	})
}

async function cloneGit(module, rewrite=false){
	return new Promise((resolve,reject)=>{
		if (moduleDirExists(module)){
			if (rewrite){
				removeModuleDir(module)
			} else {
				reject("Module directory already exists")
			}
		}
		
		if (module in modulesUrls){
			let gitUrl = modulesUrls[module]
			let destination = getModuleDir(module)
			
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
							fs.rmSync(destination+"/bitcoin", { recursive: true, force: true })
						}
						
						fs.cpSync(destination+"/bitcoin-"+version,destination+"/bitcoin", {recursive:true})
					} catch (err) {
						reject(err)
					}
					
					resolve(true)
				})
			})
		} else {
			reject("There's no support for "+coin+" in "+network+" network yet")
		}
	})
}

async function getStatus(coin, network, printStatus = false){
	await loadInstalledModules(coin, network)
	
	let coins = Object.keys(installedModules)
	
	if (coins.length > 0){
		//if (printStatus){console.log("Modules installed:")}
		
		for (let nextCoin in installedModules){
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
		
							if (printStatus){
								if (containerStatus["State"]["Status"] == "Exited"){
									console.log(" \x1b[31m"+nextCoinNetworkModule+" ("+containerStatus["State"]["Status"]+")\x1b[37m")
								} else {
									console.log(" \x1b[32m"+nextCoinNetworkModule+" ("+containerStatus["State"]["Status"]+")\x1b[37m")
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
					delete installedModules[nextCoin][nextCoinNetwork]
				}
			}
			
			if (Object.keys(nextCoinNetworks).length == 0){
				delete installedModules[nextCoin]
			} 
		}
		
		if (printStatus){console.log("")}
	}
	
	return installedModules
}

async function loadInstalledModules(coin, network){
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
	return new Promise((resolve, reject) => {
		exec('docker restart '+containerId, (error, stdout, stderr) => {
			if (error){
				reject(error)
			} else {
				let response = stdout.trim()
				
				if (response == containerId){
					resolve(true)
				} else {
					reject("There was an error trying to restart a docker container")
				}
			}
		})
	})
}

async function removeContainer(containerId){
	return new Promise((resolve, reject) => {
		exec('docker rm '+containerId, (error, stdout, stderr) => {
			if (error){
				reject(error)
			} else {
				let response = stdout.trim()
				
				if (response == containerId){
					resolve(true)
				} else {
					reject("There was an error trying to remove a docker container")
				}
			}
		})
	})
}

async function killContainer(containerId){
	return new Promise((resolve, reject) => {
		exec('docker kill '+containerId, (error, stdout, stderr) => {
			if (error){
				reject(error)
			} else {
				let response = stdout.trim()
				
				if (response == containerId){
					resolve(true)
				} else {
					reject("There was an error trying to kill a docker container")
				}
			}
		})
	})
}

async function installModule(coin, network, module){
	return new Promise(async (resolve, reject) => {
		if (module == NODE_MODULE_NAME){
			try {
				await getCryptoNode(coin, network, "27.0")
				await buildCryptoNode(coin, network)
				resolve(true)
			} catch (err){
				reject(err)
			}
		} else if (module == DB_MODULE_NAME) {
			try {
				await buildDatabaseModule(coin, network)
				resolve(true)
			} catch (err){
				reject(err)
			}
		} else {
			try {
				await cloneGit(module, true)
				await buildAndUp(module, coin, network)
				
				if (module == XChainModule.XCHAIN_DECODER){
					console.log("Adding database module to the docker network")
					await addContainerToNetwork(DB_MODULE_NAME, coin, network)
					console.log("Adding decoder user to the database")
					await addUserPasswordToDatabase(module, coin, network)
				}
				
				resolve(true)
			} catch (err){
				reject(err)
			}
		}
		
		reject("Can't install the module, it doesn't exist")
	})
}

async function installNode(coin, network){
	console.log("Creating xchain docker network...")
	await createDockerNetwork(coin, network)
	
	console.log("Installing database...")
	await buildDatabaseModule(coin, network)
	
	console.log("Installing bitcoin node...")
	await getCryptoNode(coin, network, "27.0")
	await buildCryptoNode(coin, network)
	
	console.log("Downloading xchain-encoder...")
	await cloneGit(XChainModule.XCHAIN_ENCODER, true)
	console.log("Building xchain-encoder container...")
	await buildAndUp(XChainModule.XCHAIN_ENCODER, coin, network)
	
	console.log("Downloading xchain-decoder...")
	await cloneGit(XChainModule.XCHAIN_DECODER, true)
	console.log("Building xchain-decoder container...")
	await buildAndUp(XChainModule.XCHAIN_DECODER, coin, network)
	
	console.log("Downloading xchain-address-indexer...")
	await cloneGit(XChainModule.XCHAIN_ADDRESS_INDEXER, true)
	console.log("Building xchain-address-indexer...")
	await buildAndUp(XChainModule.XCHAIN_ADDRESS_INDEXER, coin, network)
	
	if (network == Network.REGTEST){
		console.log("Downloading xchain-regtest-miner...")
		await cloneGit(XChainModule.XCHAIN_REGTEST_MINER, true)
		console.log("Building xchain-regtest_miner...")
		await buildAndUp(XChainModule.XCHAIN_REGTEST_MINER, coin, network)
	}
	
	try {
		await setDatabaseParameters()
	} catch(err){
		console.log("WARNING! The database parameters couldn't be set")
	}
	
	return true
}

async function modulesSelectionInterface(coin, network){
	return new Promise(async (resolve, reject) => {
		let modulesStatus = await getStatus(coin, network, false)
	
		let moduleChoices = []
		let actionModules = {}
		
		let onlyOneModuleUsingDatabase = false //If the module database is used by many modules, then it can't be removed
		
		if ((coin in modulesStatus) && (network in modulesStatus[coin])){
			onlyOneModuleUsingDatabase = !((modulesStatus.length > 2) || (modulesStatus[coin].length > 1)) //If the database module exists, it will count as one		
		
			//Add the database module to the coin
			if (("" in modulesStatus) && ("" in modulesStatus[""]) && ("db" in modulesStatus[""][""])){
				modulesStatus[coin][network]["db"] = modulesStatus[""][""]["db"]
			}
		
			let allModules = Object.values(XChainModule)
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
				} else if (moduleAnswer in actionModules){
					let selectedModuleStatus = actionModules[moduleAnswer]["status"]
				
					if (selectedModuleStatus != "missing"){
						let moduleActions = []
						
						if (actionModules[moduleAnswer]["value"] != DB_MODULE_NAME){
							moduleActions.push({name: "Uninstall",	value: "uninstall"})
						}
						
						if (selectedModuleStatus == "exited"){
							moduleActions.push({name: "Restart", value: "restart"})
						}
						
						moduleActions.push({name: "Return",	value: "return"})
						
						let modulesActionSelect = new Select({
							name: 'action',
							message: 'What do you want to do with the selected module?',
							choices: moduleActions
						})
						
						modulesActionSelect.run().then(
							async (moduleActionAnswer) => {
								if (moduleActionAnswer == "Uninstall"){
									try {
										if (selectedModuleStatus != "exited"){
											await killContainer(actionModules[moduleAnswer]["container_id"])
										}
										
										await removeContainer(actionModules[moduleAnswer]["container_id"])
										//TODO: remove module from database
									} catch (err){
										console.log(err)
										console.log("There was a problem trying to kill/remove a container")
									}
								} else if (moduleActionAnswer == "Restart"){
									try {
										await restartContainer(actionModules[moduleAnswer]["container_id"])
									} catch (err){
										console.log(err)
										console.log("There was a problem trying to restart a container")
									}
								} 
								
								resolve({
									menuFunction:modulesSelectionInterface, 
									parameters:[coin, network]
								})
							}
						)
					} else {
						let moduleActions = [
							{name: "Install",	value: "install"},
							{name: "Return",	value: "return"}
						]
						
						let modulesActionSelect = new Select({
							name: 'action',
							message: 'What do you want to do with the selected module?',
							choices: moduleActions
						})
						
						modulesActionSelect.run().then(
							async (moduleActionAnswer) => {
								if (moduleActionAnswer == "Install"){
									try {
										await installModule(coin, network, actionModules[moduleAnswer]["value"])
									} catch (err){
										console.log(err)
										console.log("There was a problem trying to install the module")
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
						{name:'Configure database network parameters',value:'configure_database'},
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
				} else if (answer == "Configure database network parameters"){
					try {
						await setDatabaseParameters()
					} catch(err){
						console.log("WARNING! The database parameters couldn't be set")
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
	await db.createDatabase()
	try {
		await checkDockerInstalledAndReachable()
	} catch(err){
		throw new Error("Docker is not installed or is unreachable. Xchain-node needs Docker to install its modules. Make sure docker commands can be run under this user.")
	}
	
	await startInterface()
}

start()