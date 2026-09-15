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
 * XChain Node - Docker Service: Container Logs
 * Container log streaming, the split-pane docker monitor and saving logs to a file
 ********************************************************************/

const { spawn }   = require('child_process')
const fs          = require('fs')
const path        = require('path')
const blessed     = require('blessed')

const MAX_CONTAINERS = 6

const { getLogger } = require('../../observability/logger');
const logger = getLogger();

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

        // Disclose truncation: when more than MAX_CONTAINERS were requested, the
        // split-pane view can only show the first MAX_CONTAINERS, so name every
        // container that is being dropped (mirrors the logModules omission warning)
        // and label the banner `n of N` so a truncated view is never mistaken for
        // the whole fleet.
        const truncated = containerIds.length > MAX_CONTAINERS
        if (truncated) {
            const omitted = containerIds.slice(MAX_CONTAINERS).map(c => c["name"]).join(", ")
            logger.info("Monitoring only " + n + " of " + containerIds.length + " containers; omitted: " + omitted)
        }

        const screen = blessed.screen({
            smartCSR: true,
            title: 'XChain Containers Logs',
            warnings: true
        })

        blessed.text({
            parent: screen,
            top: 0,
            left: 'center',
            content: truncated
                ? ` Monitoring ${n} of ${containerIds.length} containers (Q - Exit) `
                : ` Monitoring ${n} containers (Q - Exit) `,
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
    MAX_CONTAINERS,
    logContainer,
    startDockerMonitor,
    saveContainerLogs
}
