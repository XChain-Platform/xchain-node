/*********************************************************************
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
                // Network doesn't exist — create it
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

async function getAllContainerFromModule(module, coin, network) {
    const { getDockerContainerImageName } = require('./ConfigService')
    return new Promise((resolve) => {
        const imageName = getDockerContainerImageName(module, coin, network)
        execFile('docker', ['ps', '--no-trunc', '-q', '-a', '-f', 'ancestor=' + imageName], () => {
            resolve(true)
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
        execFile('docker', ['rm', containerId], (error, stdout) => {
            if (error) {
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
        child.stdout.pipe(output)
        child.stderr.pipe(output)
        child.on('close', () => {
            output.end()
            resolve(true)
        })
        child.on('error', reject)
    })
}

module.exports = {
    checkDockerInstalledAndReachable,
    getStatusFromContainer,
    getDockerNetworkInspect,
    createDockerNetwork,
    addContainerToNetwork,
    getAllContainerFromModule,
    getDockerContainerFileData,
    getDockerContainerFileCat,
    stringToDockerContainerFile,
    stopContainer,
    startContainer,
    restartContainer,
    removeContainer,
    killContainer,
    execContainer,
    shellContainer,
    logContainer,
    startDockerMonitor,
    waitContainer,
    saveContainerLogs
}
