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
 * XChain Node - Docker Manager class
 * 
 ********************************************************************/

// Load required libraries
const { exec, spawn, spawnSync }   = require('child_process')
const blessed    = require('blessed')

const MAX_CONTAINERS = 6;

class DockerManager {
    constructor() {
        
    }

    /**
    * Monitors multiple containers in divided panels.
    */
    async startDockerMonitor(containerIds, follow) {
        return new Promise((resolve, reject) => {
            const children = [] // The process will be stored here
            // Validations
            if (!containerIds || containerIds.length === 0) {
                reject("No container was selected to get the logs")
                return
            }

            const idsToMonitor = containerIds.slice(0, MAX_CONTAINERS);
            const n = idsToMonitor.length;

            // Create the main screen
            const screen = blessed.screen({
                smartCSR: true,
                title: 'XChain Containers Logs',
                warnings: true
            });

            // Title
            blessed.text({
                parent: screen,
                top: 0,
                left: 'center',
                content: ` Monitoring ${n} containers (Q - Exit) `,
                style: { bg: 'blue', fg: 'white', bold: true }
            });

            // Create the dynamic panels
            idsToMonitor.forEach((id, index) => {
                const heightPercentage = 100 / n;

                const logger = blessed.log({
                    parent: screen,
                    top: `${heightPercentage * index}%`,
                    left: 0,
                    width: '100%',
                    height: `${heightPercentage}%`,
                    label: ` [ ${id["name"]} ] `,
                    border: { type: 'line' },
                    //scrollable: true,
                    //alwaysScroll: true,
                    //scrollbar: { ch: ' ', inverse: true },
                    style: {
                        border: { fg: 'cyan' },
                        label: { fg: 'yellow' }
                    }
                })

                // Execute docker command
                const child = spawn('docker', ['logs', '--tail', '100', (follow?'-f':null), id["id"]].filter(item => item != null));
                children.push(child)

                child.stdout.on('data', (data) => {
                    logger.log(data.toString().trim());
                });

                child.stderr.on('data', (data) => {
                    // normally, Docker sends the logs through stderr sometimes, 
                    // but here they get marked if they are actually an error.
                    logger.log(`{red-fg}${data.toString().trim()}{/red-fg}`);
                });

                child.on('error', (err) => {
                    logger.log(`{red-fg}Error al conectar: ${err.message}{/red-fg}`);
                });
            });

            // Handles the exit
            screen.key(['escape','q', 'C-c'], () => {
                // Kill every spawn made
                children.forEach(child => child.kill()); 
                screen.destroy()
                resolve(true)
            })

            // Handles when the terminal is resized
            screen.on('resize', () => screen.render());

            screen.render();
        })
    }
    
    async getDockerNetworkInspect(dockerNetwork){
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
    
    async stopContainer(containerId){
        return new Promise(async (resolve, reject) => {
            exec('docker stop '+containerId, async (error, stdout, stderr) => {
                if (error){
                    reject(error)
                } else {
                    let response = stdout.trim()
                    
                    if (response == containerId){
                        resolve(true)
                    } else {
                        reject("There was an error trying to stop the docker container ("+containerId+")")
                    }
                }
            })
        })
    }
    
    async restartContainer(containerId){
        return new Promise(async (resolve, reject) => {
            exec('docker restart '+containerId, async (error, stdout, stderr) => {
                if (error){
                    reject(error)
                } else {
                    let response = stdout.trim()
                    
                    if (response == containerId){
                        resolve(true)
                    } else {
                        reject("There was an error trying to restart the docker container ("+containerId+")")
                    }
                }
            })
        })
    }
    
    async startContainer(containerId){
        return new Promise(async (resolve, reject) => {
            exec('docker start '+containerId, async (error, stdout, stderr) => {
                if (error){
                    reject(error)
                } else {
                    let response = stdout.trim()
                    
                    if (response == containerId){
                        resolve(true)
                    } else {
                        reject("There was an error trying to restart the docker container ("+containerId+")")
                    }
                }
            })
        })
    }
    
    async execContainer(containerId, command){
        return new Promise(async (resolve, reject) => {
            exec('docker exec -i '+containerId+' '+command, async (error, stdout, stderr) => {
                if (error){
                    reject(error)
                } else {
                    let response = stdout.trim()
                    resolve(response)
                }
            })
        })
    }
    
    async shellContainer(containerId){
        return new Promise(async (resolve, reject) => {
            spawnSync('docker', ['exec', '-it', containerId, 'bash'], {
                stdio: 'inherit' 
            })
            
            resolve(true)
        })
    }
    
    async logContainer(containerId, follow = true){
        return new Promise(async (resolve, reject) => {
            let parameters = ['logs', '--tail', '10', containerId]
            if (follow){
                parameters.splice(3, 0, "--follow")
            }
        
            spawnSync('docker', parameters, {
                stdio: 'inherit' 
            })
            
            resolve(true)
        })
    }
}

module.exports = DockerManager