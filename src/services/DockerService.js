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
 * XChain Node - Docker Service
 * Low-level Docker utilities (network, container operations)
 ********************************************************************/

const { execFile, spawn, spawnSync } = require('child_process')
const fs          = require('fs')
const path        = require('path')
const blessed     = require('blessed')

const MAX_CONTAINERS = 6

const { containersFilesDir }     = require('../config/constants')

async function checkDockerInstalledAndReachable() {
    return new Promise((resolve, reject) => {
        execFile('docker', ['--version'], (error, stdout) => {
            if (error) {
                reject("Couldn't use the command docker --version")
                return
            }
            const result = stdout.split(" ")
            if (result.length !== 5) {
                reject("The format returned by docker --version is unknown")
                return
            }
            execFile('docker', ['ps', '-a'], (error2) => {
                if (error2) {
                    reject("Couldn't execute docker ps, is this user in the docker group")
                } else {
                    resolve(true)
                }
            })
        })
    })
}

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
                console.log("Creating docker network " + networkName)
                execFile('docker', ['network', 'create', networkName], (err2) => {
                    if (err2) {
                        console.log(err2)
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
            console.log("Connecting container " + containerId + " to network " + networkName)
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
// ports, so `docker ps` (running only) is the correct scope. Used to detect
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

async function restartContainer(containerId) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['restart', containerId], (error, stdout) => {
            if (error) {
                reject(error)
                return
            }
            if (stdout.trim() === containerId) {
                resolve(true)
            } else {
                reject("There was an error trying to restart a docker container")
            }
        })
    })
}

async function removeContainer(containerId) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['rm', containerId], (error, stdout, stderr) => {
            if (error) {
                // Treat "No such container" as success: the desired state
                // (container is gone) is already met. Without this, callers
                // like runE2ETest crash if the container was already cleaned
                // up by something else (e.g. another invocation, manual rm,
                // or an auto-remove edge case).
                if (stderr && /no such container/i.test(stderr)) {
                    resolve(true)
                    return
                }
                reject(error)
                return
            }
            if (stdout.trim() === containerId) {
                resolve(true)
            } else {
                reject("There was an error trying to remove a docker container")
            }
        })
    })
}

async function stopContainer(containerId) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['stop', containerId], (error, stdout) => {
            if (error) {
                reject(error)
            } else if (stdout.trim() === containerId) {
                resolve(true)
            } else {
                reject("There was an error trying to stop the docker container (" + containerId + ")")
            }
        })
    })
}

async function startContainer(containerId) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['start', containerId], (error, stdout) => {
            if (error) {
                reject(error)
            } else if (stdout.trim() === containerId) {
                resolve(true)
            } else {
                reject("There was an error trying to start the docker container (" + containerId + ")")
            }
        })
    })
}

async function execContainer(containerId, commandArgs) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['exec', '-i', containerId, ...commandArgs], (error, stdout) => {
            if (error) {
                reject(error)
            } else {
                resolve(stdout.trim())
            }
        })
    })
}

async function shellContainer(containerId) {
    return new Promise((resolve) => {
        spawnSync('docker', ['exec', '-it', containerId, 'bash'], { stdio: 'inherit' })
        resolve(true)
    })
}

async function logContainer(containerId, follow = true) {
    return new Promise((resolve) => {
        let parameters = ['logs', containerId]
        if (follow) {
            parameters.splice(1, 0, '--tail', '10', '--follow')
        }

        const child = spawn('docker', parameters, { stdio: ['pipe', 'inherit', 'inherit'] })

        const killChild = () => child.kill('SIGTERM')

        const onKeypress = (key) => {
            if (key === '\u001b' || key === '\u0003') killChild()
        }

        process.once('SIGINT', killChild)

        if (follow && process.stdin.isTTY) {
            process.stdin.setRawMode(true)
            process.stdin.resume()
            process.stdin.setEncoding('utf8')
            process.stdin.on('data', onKeypress)
        }

        child.on('close', () => {
            process.removeListener('SIGINT', killChild)
            if (follow && process.stdin.isTTY) {
                process.stdin.removeListener('data', onKeypress)
                process.stdin.setRawMode(false)
                process.stdin.pause()
            }
            resolve(true)
        })
    })
}

async function startDockerMonitor(containerIds, follow) {
    return new Promise((resolve, reject) => {
        const children = []
        if (!containerIds || containerIds.length === 0) {
            reject("No container was selected to get the logs")
            return
        }

        const idsToMonitor = containerIds.slice(0, MAX_CONTAINERS)
        const n = idsToMonitor.length

        const screen = blessed.screen({
            smartCSR: true,
            title: 'XChain Containers Logs',
            warnings: true
        })

        blessed.text({
            parent: screen,
            top: 0,
            left: 'center',
            content: ` Monitoring ${n} containers (Q - Exit) `,
            style: { bg: 'blue', fg: 'white', bold: true }
        })

        idsToMonitor.forEach((id, index) => {
            const heightPercentage = 100 / n

            const logger = blessed.log({
                parent: screen,
                top: `${heightPercentage * index}%`,
                left: 0,
                width: '100%',
                height: `${heightPercentage}%`,
                label: ` [ ${id["name"]} ] `,
                border: { type: 'line' },
                style: {
                    border: { fg: 'cyan' },
                    label: { fg: 'yellow' }
                }
            })

            const child = spawn('docker', ['logs', '--tail', '100', (follow ? '-f' : null), id["id"]].filter(item => item != null))
            children.push(child)

            child.stdout.on('data', (data) => {
                logger.log(data.toString().trim())
            })

            child.stderr.on('data', (data) => {
                logger.log(`{red-fg}${data.toString().trim()}{/red-fg}`)
            })

            child.on('error', (err) => {
                logger.log(`{red-fg}Error: ${err.message}{/red-fg}`)
            })
        })

        screen.key(['escape', 'q', 'C-c'], () => {
            children.forEach(child => child.kill())
            screen.destroy()
            resolve(true)
        })

        screen.on('resize', () => screen.render())
        screen.render()
    })
}

async function killContainer(containerId) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['kill', containerId], (error, stdout) => {
            if (error) {
                reject(error)
                return
            }
            if (stdout.trim() === containerId) {
                resolve(true)
            } else {
                reject("There was an error trying to kill a docker container")
            }
        })
    })
}

// Force-remove a container by NAME (kill + remove in one shot), tolerating
// "no such container". Used immediately before a `docker run --name X` to make
// (re)creation idempotent: it clears both a previous running container of that
// name (the `update` path, where the old container is never auto-removed) AND a
// leftover `Created`-state carcass from a failed earlier create, either of
// which would otherwise collide on the name and fail the run. Keying on the
// name (not a registry id) is deliberate: it also catches containers the
// module registry never recorded (e.g. a create that died before insert).
async function forceRemoveContainerByName(name) {
    return new Promise((resolve) => {
        execFile('docker', ['rm', '-f', name], (error, stdout, stderr) => {
            if (error) {
                // "No such container" is the desired state already; succeed.
                // Any other error (e.g. daemon unreachable) is surfaced by the
                // subsequent `docker run` anyway, so don't reject here and risk
                // masking the real run error or breaking the fresh-install path.
                resolve(false)
                return
            }
            resolve(true)
        })
    })
}

async function waitContainer(containerId) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['wait', containerId], (error, stdout) => {
            if (error) {
                reject(error)
            } else {
                resolve(parseInt(stdout.trim()))
            }
        })
    })
}

async function saveContainerLogs(containerId, filePath) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const output = fs.createWriteStream(filePath)
        const child = spawn('docker', ['logs', containerId])
        // { end: false } on both pipes: the default end:true makes whichever
        // stream closes first call output.end(), which silently drops any
        // remaining writes from the other stream. End the output manually
        // only after the child process exits (both streams closed).
        child.stdout.pipe(output, { end: false })
        child.stderr.pipe(output, { end: false })
        child.on('close', () => output.end())
        child.on('error', reject)
        // Resolve only after the output is fully flushed to disk; otherwise
        // the caller can read a truncated file.
        output.on('finish', () => resolve(true))
        output.on('error', reject)
    })
}

module.exports = {
    checkDockerInstalledAndReachable,
    getStatusFromContainer,
    getDockerNetworkInspect,
    createDockerNetwork,
    addContainerToNetwork,
    getPublishedHostPorts,
    getDockerContainerFileData,
    getDockerContainerFileCat,
    stringToDockerContainerFile,
    stopContainer,
    startContainer,
    restartContainer,
    removeContainer,
    killContainer,
    forceRemoveContainerByName,
    execContainer,
    shellContainer,
    logContainer,
    startDockerMonitor,
    waitContainer,
    saveContainerLogs
}
