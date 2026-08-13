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
 * XChain Node - Version Service
 * Checks local, remote and container versions of modules
 ********************************************************************/

const fs    = require('fs')
const axios = require('axios')

const {
    NODE_MODULE_NAME, EXPLORER_MODULE_NAME, SEP,
    XChainService, Coin, NODE_VERSION_FILE_NAME, projectFolders
} = require('../config/constants')
const { gitHubDownloader, getRemoteModuleVersions, setRemoteModuleVersion } = require('../state')
const { githubApiHeaders, githubRateLimitError }                             = require('../GitHubDownloader')
const { getModuleDir, getModuleTmpDir, getCryptoNodeDir }                   = require('./ConfigService')
const { getDockerContainerFileData, getDockerContainerFileCat }              = require('./DockerService')

/**
 * Reads one file out of a container, exec-first.
 *
 * `docker cp` was the only probe here, and it materializes the path on the
 * HOST, so it inherits host-side failure modes that have nothing to do with the
 * file being read: on the live hub the daemon refuses every copy with
 * "mkdirat validator/capabilities.json: file exists", including a copy to a
 * freshly emptied destination. That made the hub's version permanently
 * unreadable and, through the skew guard, made every indexer update refuse.
 * `docker exec cat` needs no host filesystem at all and reads the same bytes.
 *
 * The copy is kept as the fallback rather than deleted: `docker cp` works on a
 * STOPPED container, which `docker exec` cannot enter, and the version of a
 * stopped module is exactly what `ps` wants to show.
 */
async function readContainerFile(containerId, filePath) {
    let execErr
    try {
        return await getDockerContainerFileCat(containerId, filePath)
    } catch (err) {
        execErr = err
    }
    try {
        return await getDockerContainerFileData(containerId, filePath)
    } catch (copyErr) {
        // Report BOTH attempts: a caller that sees only the second failure
        // cannot tell "container is gone" from "host copy is broken".
        throw new Error(
            'docker exec read failed (' + (execErr && execErr.message ? execErr.message : execErr) + ')' +
            '; docker cp fallback also failed (' + (copyErr && copyErr.message ? copyErr.message : copyErr) + ')'
        )
    }
}

async function getGithubProjectVersion(owner, repoName) {
    const url = "https://api.github.com/repos/" + owner + "/" + repoName + "/releases/latest"
    let result
    try {
        result = await axios.get(url, { headers: githubApiHeaders() })
    } catch (error) {
        throw githubRateLimitError(error) || error
    }
    const json = result.data

    let tagName = json["tag_name"]
    if (tagName.charAt(0) === 'v') tagName = tagName.substring(1)

    return { version: tagName, id: json["id"] }
}

async function checkRemoteNodeVersion(coin) {
    let githubProjectVersion = null

    switch (coin) {
        case Coin.BITCOIN:
            githubProjectVersion = await gitHubDownloader.getLatestCompatibleVersion("bitcoin", "bitcoin", true)
            break
        case Coin.DOGECOIN:
            githubProjectVersion = await gitHubDownloader.getLatestCompatibleVersion("dogecoin", "dogecoin", true)
            break
        case Coin.LITECOIN:
            githubProjectVersion = await gitHubDownloader.getLatestCompatibleVersion("litecoin-project", "litecoin", true)
            break
    }

    setRemoteModuleVersion(NODE_MODULE_NAME + SEP + coin, githubProjectVersion)
}

async function getRemoteModuleVersion(module) {
    const { cloneGit } = require('./ModuleService')
    await cloneGit(module, false, true)
    const packageJsonFilePath = getModuleTmpDir(module) + "/package.json"

    return new Promise((resolve, reject) => {
        if (fs.existsSync(packageJsonFilePath)) {
            fs.readFile(packageJsonFilePath, 'utf8', (err, data) => {
                if (err) {
                    reject("There was a problem reading the package.json file of remote module " + module)
                    return
                }
                try {
                    const pkg = JSON.parse(data)
                    setRemoteModuleVersion(module, pkg["version"])
                    resolve(pkg["version"])
                } catch (error) {
                    reject("There was a problem parsing the package.json file of remote module " + module)
                }
            })
        } else {
            reject("There was a problem reading the package.json of remote module " + module + ": no file found")
        }
    })
}

async function checkAllRemoteVersions() {
    return Promise.all([
        getRemoteModuleVersion(XChainService.XCHAIN_ENCODER),
        getRemoteModuleVersion(XChainService.XCHAIN_DECODER),
        getRemoteModuleVersion(XChainService.XCHAIN_UTXO_TRACKER),
        getRemoteModuleVersion(XChainService.XCHAIN_REGTEST_MINER),
        getRemoteModuleVersion(XChainService.XCHAIN_INDEXER),
        getRemoteModuleVersion(EXPLORER_MODULE_NAME)
    ])
}

async function getLocalNodeVersion(coin, network) {
    return new Promise((resolve, reject) => {
        const nodeVersionFile = getCryptoNodeDir(coin) + "/" + coin + "/" + NODE_VERSION_FILE_NAME
        if (fs.existsSync(nodeVersionFile)) {
            fs.readFile(nodeVersionFile, 'utf8', (err, data) => {
                if (err) {
                    reject("There was a problem reading version file of local crypto node " + coin + ":" + err)
                    return
                }
                resolve(data)
            })
        } else {
            reject("There was a problem reading version file of local crypto node " + coin + ": No file")
        }
    })
}

async function getContainerNodeVersion(coin, network, containerId) {
    const versionFilePath = "/" + coin + "/" + NODE_VERSION_FILE_NAME
    try {
        return await readContainerFile(containerId, versionFilePath)
    } catch (err) {
        throw "There was an error trying to get the version file for the node " + coin + ":" + err
    }
}

async function getLocalModuleVersion(module) {
    return new Promise((resolve, reject) => {
        const packageJsonFilePath = getModuleDir(module) + "/package.json"
        if (fs.existsSync(packageJsonFilePath)) {
            fs.readFile(packageJsonFilePath, 'utf8', (err, data) => {
                if (err) {
                    reject("There was a problem reading the package.json of local module " + module + ":" + err)
                    return
                }
                try {
                    const pkg = JSON.parse(data)
                    if ("version" in pkg) {
                        resolve(pkg["version"])
                    } else {
                        reject("Couldn't find version info in package.json of local module " + module)
                    }
                } catch (error) {
                    reject("There was a problem parsing package.json of local module " + module + ":" + error)
                }
            })
        } else {
            reject("There was a problem reading package.json of local module " + module + ": no file found")
        }
    })
}

async function getContainerModuleVersion(module, coin, network, containerId) {
    const packageJsonFilePath = "/" + projectFolders[module] + "/package.json"
    try {
        const containerVersion = await readContainerFile(containerId, packageJsonFilePath)
        const json = JSON.parse(containerVersion)
        return json["version"]
    } catch (err) {
        throw "There was an error trying to get package.json from module container " + module + " (" + coin + " " + network + "): " + err
    }
}

module.exports = {
    readContainerFile,
    getGithubProjectVersion,
    checkRemoteNodeVersion,
    getRemoteModuleVersion,
    checkAllRemoteVersions,
    getLocalNodeVersion,
    getContainerNodeVersion,
    getLocalModuleVersion,
    getContainerModuleVersion
}
