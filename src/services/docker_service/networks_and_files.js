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
 * XChain Node - Docker Service: Networks and Files
 * Container status, docker networks, published host ports and container file reads and writes
 ********************************************************************/

const { execFile, spawn } = require('child_process')
const fs          = require('fs')
const path        = require('path')

const { containersFilesDir }     = require('../../config')
const { getLogger } = require('../../observability/logger');
const logger = getLogger();

async function getStatusFromContainer(containerId) {
    return new Promise((resolve, reject) => {
        try {
            execFile('docker', ['inspect', containerId], (error, stdout) => {
                if (error) {
                    reject(error)
                } else {
                    resolve(JSON.parse(stdout)[0])
                }
            })
        } catch (err) {
            reject(err)
        }
    })
}

async function getDockerNetworkInspect(dockerNetwork) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['network', 'inspect', dockerNetwork], (error, stdout) => {
            if (error) {
                reject(error)
            } else {
                resolve(JSON.parse(stdout)[0])
            }
        })
    })
}

async function createDockerNetwork(networkName) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['network', 'inspect', networkName], (error) => {
            if (error) {
                // Network doesn't exist; create it
                logger.info("Creating docker network " + networkName)
                execFile('docker', ['network', 'create', networkName], (err2) => {
                    if (err2) {
                        logger.info(err2)
                        reject(false)
                    } else {
                        resolve(true)
                    }
                })
            } else {
                resolve(true)
            }
        })
    })
}

async function addContainerToNetwork(containerId, networkName) {
    const containerStatus = await getStatusFromContainer(containerId)

    return new Promise((resolve, reject) => {
        if (!(networkName in containerStatus["NetworkSettings"]["Networks"])) {
            logger.info("Connecting container " + containerId + " to network " + networkName)
            execFile('docker', ['network', 'connect', networkName, containerId], (error) => {
                if (error) {
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

// Map every host port currently published by a RUNNING container to the
// name(s) of the container(s) holding it. Stopped containers don't bind host
// ports, so `docker ps` (running only) is the correct scope. It detects
// host-port collisions BEFORE `docker run` on multi-stack hosts, where two
// NODE_PREFIX stacks, or a hand-created service container, can contend for
// the same host port and otherwise only surface a cryptic "port is already
// allocated" after the image build. Best-effort: any docker failure yields an
// empty map so the subsequent `docker run` still surfaces the real error.
async function getPublishedHostPorts() {
    return new Promise((resolve) => {
        execFile('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], (error, stdout) => {
            const portToContainers = new Map()
            if (error || !stdout) {
                resolve(portToContainers)
                return
            }
            for (const line of stdout.split('\n')) {
                if (!line.trim()) continue
                const tab = line.indexOf('\t')
                if (tab === -1) continue
                const name  = line.substring(0, tab).trim()
                const ports = line.substring(tab + 1)
                // Published bindings render as "IP:HOSTPORT->CONTAINERPORT/proto"
                // (0.0.0.0:, :::, or 127.0.0.1:). Exposed-but-unpublished ports
                // have no "->" and are correctly skipped. Key on host port number
                // only: a 0.0.0.0 bind conflicts with any specific-IP bind on the
                // same port, so the conservative match avoids missing real clashes.
                const re = /:(\d+)->/g
                let m
                while ((m = re.exec(ports)) !== null) {
                    const hostPort = m[1]
                    if (!portToContainers.has(hostPort)) portToContainers.set(hostPort, new Set())
                    portToContainers.get(hostPort).add(name)
                }
            }
            resolve(portToContainers)
        })
    })
}

async function getDockerContainerFileData(containerId, filePath) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['cp', containerId + ':' + filePath, containersFilesDir], (error) => {
            if (error) {
                reject(error)
            } else {
                const data = fs.readFileSync(path.join(containersFilesDir, path.basename(filePath)), 'utf8')
                resolve(data)
            }
        })
    })
}

async function getDockerContainerFileCat(containerId, filePath) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['exec', '-i', containerId, 'cat', filePath], (error, stdout) => {
            if (error) {
                reject(error)
            } else {
                resolve(stdout)
            }
        })
    })
}

async function stringToDockerContainerFile(containerId, dataString, filePath) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', ['exec', '-i', containerId, 'tee', filePath])
        let stderr = ''
        child.stderr.on('data', (d) => { stderr += d })
        child.stdin.write(dataString)
        child.stdin.end()
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve(true)
            else reject(new Error(`stringToDockerContainerFile exited with code ${code}: ${stderr}`))
        })
    })
}

module.exports = {
    getStatusFromContainer,
    getDockerNetworkInspect,
    createDockerNetwork,
    addContainerToNetwork,
    getPublishedHostPorts,
    getDockerContainerFileData,
    getDockerContainerFileCat,
    stringToDockerContainerFile
}
