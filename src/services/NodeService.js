/*********************************************************************
 * XChain Node - Node Service
 * Download, build and install cryptocurrency nodes
 ********************************************************************/

const { execFile } = require('child_process')
const { https } = require('follow-redirects')
const fs        = require('fs')
const path      = require('path')
const semver    = require('semver')

const {
    NODE_MODULE_NAME, NODE_VERSION_FILE_NAME, SEP,
    Coin, Network, XChainService
} = require('../config/constants')
const nodeVersion = process.versions.node

const { gitHubDownloader, db, getRemoteModuleVersions } = require('../state')
const { decompressTarGz }               = require('../utils/helpers')
const { cryptoNodesDir }                = require('../config/constants')
const { getDockerContainerImageName, getDockerNetwork, getDefaultConfig } = require('./ConfigService')
const { statusChanged }                 = require('./StatusService')
const { checkRemoteNodeVersion }        = require('./VersionService')

async function getCryptoNode(coin, network, version) {
    if (coin === Coin.BITCOIN) {
        if (version.startsWith("v")) version = version.substring(1)

        console.log("Downloading bitcoin node...")
        const destination = cryptoNodesDir + "/bitcoin"
        const filePath = destination + "/bitcoin" + version + ".tar.gz"

        const bitcoinNodeFile = fs.createWriteStream(filePath)
        // Pick the right prebuilt tarball for the host architecture.
        // bitcoincore.org publishes x86_64-linux-gnu and aarch64-linux-gnu builds.
        const archMap = { x64: 'x86_64', arm64: 'aarch64' }
        const arch = archMap[process.arch]
        if (!arch) throw new Error("Unsupported architecture for Bitcoin Core download: " + process.arch)
        const downloadUrl = "https://bitcoincore.org/bin/bitcoin-core-" + version + "/bitcoin-" + version + "-" + arch + "-linux-gnu.tar.gz"

        await new Promise((resolve, reject) => {
            https.get(downloadUrl, (response) => {
                response.pipe(bitcoinNodeFile)

                bitcoinNodeFile.on("error", () => {
                    console.log("An error happened while trying to download the bitcoin node")
                })

                bitcoinNodeFile.on("finish", async () => {
                    bitcoinNodeFile.close()
                    try {
                        console.log("Decompressing bitcoin node files...")
                        await decompressTarGz(filePath)

                        if (fs.existsSync(destination + "/bitcoin")) {
                            if (semver.gte(nodeVersion, "14.14.0")) {
                                fs.rmSync(destination + "/bitcoin", { recursive: true, force: true })
                            } else {
                                fs.rmdirSync(destination + "/bitcoin", { recursive: true })
                            }
                        }

                        fs.renameSync(destination + "/bitcoin-" + version, destination + "/bitcoin")
                        fs.writeFileSync(destination + "/bitcoin/" + NODE_VERSION_FILE_NAME, version)
                    } catch (err) {
                        reject(err)
                        return
                    }
                    resolve(true)
                })
            })
        })
    } else if (coin === Coin.DOGECOIN) {
        await gitHubDownloader.downloadRepoVersion("dogecoin", "dogecoin", version, { outputPath: cryptoNodesDir + "/dogecoin" })
    } else if (coin === Coin.LITECOIN) {
        await gitHubDownloader.downloadRepoVersion("litecoin-project", "litecoin", version, { outputPath: cryptoNodesDir + "/litecoin" })
    } else {
        throw new Error("There's no support for " + coin + " in " + network + " network yet")
    }
    return true
}

async function buildCryptoNode(coin, network, bitcoinVer = null) {
    const defaultConfig = await getDefaultConfig(NODE_MODULE_NAME, coin, network)
    const defaultExposedPort = defaultConfig["NODE_EXPOSED_PORT"]
    const defaultNodePort = defaultConfig["NODE_PORT"]
    const containerPrefix = getDockerContainerImageName(NODE_MODULE_NAME, coin, network)
    const nodeDir = cryptoNodesDir + "/" + coin

    // Inject the provisioned RPC credentials into the coin-node conf file
    // so the daemon and the xchain services share the same credentials.
    const confFileName = `${coin}-${network}.conf`
    const confFilePath = path.join(nodeDir, confFileName)
    if (fs.existsSync(confFilePath)) {
        let confContent = fs.readFileSync(confFilePath, 'utf8')
        confContent = confContent.replace(/^rpcuser=.*$/m,     `rpcuser=${defaultConfig['NODE_USER']}`)
        confContent = confContent.replace(/^rpcpassword=.*$/m, `rpcpassword=${defaultConfig['NODE_PASSWORD']}`)
        fs.writeFileSync(confFilePath, confContent)
    }

    return new Promise((resolve, reject) => {
        console.log("Building image of " + coin + " " + network + " node")
        execFile('docker', ['build', '.', '--build-arg', 'CONF_FILE=' + coin + '-' + network + '.conf', '-t', containerPrefix], { cwd: nodeDir }, (error) => {
            if (error) {
                console.error("Error creating Docker image: " + error.message)
                return
            }

            const { dataDir } = require('../config/constants')
            const blocksDir = process.env.XCHAIN_NODE_BLOCKS_DIR
            if (blocksDir) {
                const blocksHostPath = `${blocksDir}/${coin}/${network}`
                try {
                    fs.mkdirSync(blocksHostPath, { recursive: true })
                } catch (err) {
                    throw new Error(`XCHAIN_NODE_BLOCKS_DIR: failed to create ${blocksHostPath}: ${err.message}`)
                }
            }
            const runArgs = [
                'run', '-d',
                '--restart', 'unless-stopped',
                '--name', containerPrefix,
                '-v', `${dataDir}/${NODE_MODULE_NAME}/${coin}/${network}:/root/.${coin}`,
                '--hostname', NODE_MODULE_NAME,
                '--network-alias', NODE_MODULE_NAME,
                '--ulimit', 'nofile=2048:2048',
                '--network', getDockerNetwork(coin, network)
            ]
            if (blocksDir) {
                runArgs.push('-v', `${blocksDir}/${coin}/${network}:/blocks`)
            }
            if (defaultExposedPort && defaultNodePort) {
                runArgs.push('-p', `${defaultExposedPort}:${defaultNodePort}`)
            }
            runArgs.push('-e', `CRYPTO_NODE_VERSION=${bitcoinVer}`, '-t', containerPrefix)
            if (blocksDir) {
                const daemonName = `${coin}d`
                const confPath = `/etc/${coin}/${coin}.conf`
                if (coin === 'bitcoin') {
                    runArgs.push(daemonName, `-conf=${confPath}`, `-datadir=/root/.${coin}/`, '-blocksdir=/blocks')
                } else {
                    runArgs.push(daemonName, `-conf=${confPath}`, '-blocksdir=/blocks')
                }
            }

            console.log("Creating container of " + coin + " " + network + " node")
            execFile('docker', runArgs, { cwd: nodeDir }, async (error2, stdout) => {
                if (error2) {
                    reject("Error creating the container: " + error2.message)
                    return
                }
                try {
                    const containerId = stdout.trim()
                    if (/^[a-f0-9]{64}$/.test(containerId)) {
                        if (await db.insertModuleContainer(NODE_MODULE_NAME, coin, network, containerId)) {
                            await statusChanged()
                            resolve(containerId)
                        } else {
                            reject("There was a problem trying to store the container's id")
                        }
                    }
                } catch (err) {
                    reject(err)
                }
            })
        })
    })
}

async function installNode(coin, network) {
    console.log("Creating xchain docker network...")
    const { createDockerNetwork } = require('./DockerService')
    const { getDockerNetwork } = require('./ConfigService')
    await createDockerNetwork(getDockerNetwork(coin, network))

    console.log("Installing database...")
    const { buildDatabaseModule } = require('./DatabaseService')
    await buildDatabaseModule(coin, network)

    console.log("Installing " + coin + " " + network + " node...")
    const { getLocalNodeVersion } = require('./VersionService')
    let localNodeVersion = null
    try {
        localNodeVersion = await getLocalNodeVersion(coin, network)
    } catch { /* not installed */ }

    if (localNodeVersion == null) {
        if (!(NODE_MODULE_NAME + SEP + coin in getRemoteModuleVersions())) {
            await checkRemoteNodeVersion(coin)
        }
        const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
        if (remoteNodeVersion != null) {
            await getCryptoNode(coin, network, remoteNodeVersion)
        } else {
            throw new Error("There is no valid version to download for the " + coin + "/" + network + " node")
        }
    }
    await buildCryptoNode(coin, network)

    const { cloneGit, buildAndUp } = require('./ModuleService')

    console.log("Downloading xchain-encoder...")
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
    const { utxoTrackerVolumeHasData, ensureBootstrapUtxoTracker } = require('./BootstrapService')
    const utxoWasFresh = !(await utxoTrackerVolumeHasData(coin, network))
    await buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (utxoWasFresh) await ensureBootstrapUtxoTracker(coin, network)

    if (network === Network.REGTEST) {
        console.log("Downloading xchain-regtest-miner...")
        await cloneGit(XChainService.XCHAIN_REGTEST_MINER, true)
        console.log("Building xchain-regtest-miner...")
        await buildAndUp(XChainService.XCHAIN_REGTEST_MINER, coin, network)
    }

    console.log("Downloading xchain-indexer...")
    await cloneGit(XChainService.XCHAIN_INDEXER, true)
    console.log("Building xchain-indexer...")
    await buildAndUp(XChainService.XCHAIN_INDEXER, coin, network)

    try {
        const { setDatabaseParameters } = require('./DatabaseService')
        await setDatabaseParameters()
    } catch {
        console.log("WARNING! The database parameters couldn't be set")
    }

    await statusChanged()
    return true
}

module.exports = {
    getCryptoNode,
    buildCryptoNode,
    installNode
}
