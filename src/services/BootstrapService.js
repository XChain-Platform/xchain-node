/*********************************************************************
 * XChain Node - Bootstrap Service
 * Create and restore bootstrap files for XChain modules
 ********************************************************************/

const fs    = require('fs')
const path  = require('path')
const axios = require('axios')

const { XChainService, SEP } = require('../config/constants')
const { sleep }              = require('../utils/helpers')
const { getDefaultConfig }   = require('./ConfigService')

async function getBootstrapFilesList(coin, network, module) {
    const defaultConfig = await getDefaultConfig(module, coin, network)
    const fileList = []

    try {
        let directory = null

        switch (module) {
            case XChainService.XCHAIN_UTXO_TRACKER:
                directory = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
                break
            case XChainService.XCHAIN_DECODER:
                directory = defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
                break
        }

        const bootstrapFiles = await fs.promises.readdir(directory)
        for (const fileName of bootstrapFiles) {
            const filePath = path.join(directory, fileName)
            const stats = await fs.promises.stat(filePath)
            if (stats.isFile()) fileList.push(fileName)
        }

        return fileList
    } catch (err) {
        console.log(err)
        throw err
    }
}

async function waitForBootstrap(moduleUrl, taskId) {
    let lastProgress = -1

    while (true) {
        const data = {
            jsonrpc: '2.0',
            method: 'getbootstrapstatus',
            params: { "taskid": taskId },
            id: 1
        }

        let response = null
        try {
            response = await axios.post(moduleUrl, data)
        } catch (err) {
            console.log(err)
            throw new Error("There was an error trying to get the status of a bootstrap (" + taskId + ")")
        }

        if (response.data.result) {
            const progress = response.data.result.progress
            if (progress !== lastProgress) {
                console.log("Bootstrap progress..." + progress)
                lastProgress = progress
            }
            if (progress >= 100) {
                return true
            } else if (progress < 0) {
                throw "There was an error creating the bootstrap"
            }
        } else {
            throw "There was an error trying to get the status of a bootstrap"
        }

        await sleep(5000)
    }
}

async function waitForBootstrapRestore(moduleUrl, taskId) {
    let lastProgress = -1

    while (true) {
        const data = {
            jsonrpc: '2.0',
            method: 'getbootstraprestorestatus',
            params: { "taskid": taskId },
            id: 1
        }

        let response = null
        try {
            response = await axios.post(moduleUrl, data)
        } catch (err) {
            console.log(err)
            throw new Error("There was an error trying to get the status of a bootstrap restore (" + taskId + ")")
        }

        if (response.data.result) {
            const progress = response.data.result.progress
            if (progress !== lastProgress) {
                console.log("Bootstrap restore progress..." + progress)
                lastProgress = progress
            }
            if (progress >= 100) {
                return true
            } else if (progress < 0) {
                throw false
            }
        } else {
            throw "There was an error trying to get the status of a bootstrap restore"
        }

        await sleep(5000)
    }
}

async function restoreBootstrap(coin, network, module, fileName) {
    const defaultConfig = await getDefaultConfig(module, coin, network)

    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER: {
            const port = defaultConfig["UTXO_TRACKER_PORT"]
            const moduleUrl = "http://localhost:" + port
            const data = {
                jsonrpc: '2.0',
                method: 'restorebootstrap',
                params: { "filename": fileName },
                id: 1
            }

            let response = null
            try {
                response = await axios.post(moduleUrl, data)
            } catch (err) {
                throw err
            }

            if (response.data.result.task_id) {
                const bootstrapRestored = await waitForBootstrapRestore(moduleUrl, response.data.result.task_id)
                if (bootstrapRestored) {
                    return true
                } else {
                    throw false
                }
            } else {
                throw new Error('Error trying to restore a bootstrap')
            }
        }
    }
}

async function makeBootstrap(coin, network, module) {
    const defaultConfig = await getDefaultConfig(module, coin, network)

    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const dateTimeString = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const fileName = network + SEP + module + SEP + dateTimeString

    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER: {
            const port = defaultConfig["UTXO_TRACKER_PORT"]
            const moduleDockerVolume = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
            const moduleUrl = "http://localhost:" + port
            const data = {
                jsonrpc: '2.0',
                method: 'getbootstrap',
                params: { "filename": fileName },
                id: 1
            }

            let response = null
            try {
                response = await axios.post(moduleUrl, data)
            } catch (err) {
                throw err
            }

            if (response.data.result.task_id) {
                await waitForBootstrap(moduleUrl, response.data.result.task_id)
                if (fs.existsSync(moduleDockerVolume + "/" + fileName)) {
                    console.log("The bootstrap file is in " + moduleDockerVolume + fileName)
                    return true
                } else {
                    throw false
                }
            } else {
                throw new Error('Error trying to make a bootstrap')
            }
        }
    }
}

module.exports = {
    getBootstrapFilesList,
    waitForBootstrap,
    waitForBootstrapRestore,
    restoreBootstrap,
    makeBootstrap
}
