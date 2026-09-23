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

const { execFile, spawnSync } = require('child_process')

const {
    checkDockerInstalledAndReachable,
    checkBuildKitAvailable,
    checkMemoryLimitSupport,
    checkContainerdDataRootRelocation
} = require('./docker_service/environment_checks.js')
const {
    getStatusFromContainer,
    getDockerNetworkInspect,
    createDockerNetwork,
    addContainerToNetwork,
    getPublishedHostPorts,
    getDockerContainerFileData,
    getDockerContainerFileCat,
    stringToDockerContainerFile
} = require('./docker_service/networks_and_files.js')
const {
    logContainer,
    startDockerMonitor,
    saveContainerLogs
} = require('./docker_service/container_logs.js')

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

// Graceful stop by NAME with an explicit shutdown budget, for stateful
// containers (chain daemons) that must flush before they go. SIGTERM first;
// docker escalates to SIGKILL only after `timeoutSeconds`. Resolves
// { stopped, seconds, killed, exitCode }: `stopped` false when docker did not report
// the stop (already gone, never existed, or daemon unreachable), which the
// caller's subsequent force-remove/run surfaces, so a missing container is
// not a failure here. `killed` is the part the caller must not stay silent
// about: `docker stop` exits 0 whether the process left on SIGTERM or was
// killed at the budget, and a killed chain daemon comes back at its last
// flushed state and re-validates for hours. It is read from the container's
// exit code after the stop (SIGKILL reports 137), with the elapsed time as a
// second witness for a docker that does not answer the inspect. `exitCode` is
// that code as read (null when unreadable): a service that ends its own
// overrun drain exits non-zero inside the budget, which is not a kill but is
// not a clean stop either.
async function stopContainerByName(name, timeoutSeconds) {
    const startedAt = Date.now()
    const stopped = await new Promise((resolve) => {
        execFile('docker', ['stop', '-t', String(timeoutSeconds), name], (error, stdout) => {
            resolve(!error && stdout.trim() === name)
        })
    })
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    if (!stopped) return { stopped: false, seconds, killed: false, exitCode: null }
    const exitCode = await new Promise((resolve) => {
        execFile('docker', ['inspect', '--format', '{{.State.ExitCode}}', name], (error, stdout) => {
            const code = parseInt(String(stdout || '').trim(), 10)
            resolve(error || !Number.isFinite(code) ? null : code)
        })
    })
    const killed = exitCode === 137 || (exitCode === null && seconds >= timeoutSeconds)
    return { stopped: true, seconds, killed, exitCode }
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

// Tri-state presence probe by NAME: 'exists', 'gone', or 'unknown'.
//
// Every other lookup in this codebase collapses "genuinely absent", "daemon
// hiccup", "inspect timed out" and "payload I could not parse" into one falsy
// answer. That is right for a READ and wrong for a DELETE: a caller about to
// force-remove a STATEFUL container needs positive evidence there is nothing
// there to destroy, and a falsy lookup is not that evidence. Classification
// follows the house rule already stated at StatusService.isContainerGoneError:
// docker SAYING "no such object/container" is the only thing that means gone,
// and everything else is 'unknown' and must be treated as possibly-live.
function probeContainerPresenceByName(name) {
    return new Promise((resolve) => {
        execFile('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', name], (error, stdout, stderr) => {
            if (error) {
                const text = String((stderr || '') + ' ' + (error.stderr || '') + ' ' + (error.message || '')).toLowerCase()
                resolve(/no such (object|container)/.test(text) ? 'gone' : 'unknown')
                return
            }
            // A clean exit that did not yield an id is not an absence either.
            resolve(/^[a-f0-9]{64}$/.test(String(stdout).trim()) ? 'exists' : 'unknown')
        })
    })
}

// Bind mounts of a container, by name, as [{ source, destination }]. Returns []
// when the container does not exist (or inspect output is unparseable): the
// caller (the mount-drift guard in NodeService.buildCryptoNode) treats "no
// previous container" as "nothing to preserve", so absence must not throw.
async function getContainerBindMounts(name) {
    return new Promise((resolve) => {
        execFile('docker', ['inspect', '--format', '{{json .Mounts}}', name], (error, stdout) => {
            if (error) {
                resolve([])
                return
            }
            try {
                const mounts = JSON.parse(stdout.trim())
                resolve((Array.isArray(mounts) ? mounts : [])
                    .filter(m => m && m.Type === 'bind')
                    .map(m => ({ source: m.Source, destination: m.Destination })))
            } catch {
                resolve([])
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

module.exports = {
    checkDockerInstalledAndReachable,
    checkBuildKitAvailable,
    checkContainerdDataRootRelocation,
    checkMemoryLimitSupport,
    getStatusFromContainer,
    getDockerNetworkInspect,
    createDockerNetwork,
    addContainerToNetwork,
    getPublishedHostPorts,
    getDockerContainerFileData,
    getDockerContainerFileCat,
    stringToDockerContainerFile,
    stopContainer,
    stopContainerByName,
    startContainer,
    restartContainer,
    removeContainer,
    killContainer,
    getContainerBindMounts,
    forceRemoveContainerByName,
    probeContainerPresenceByName,
    execContainer,
    shellContainer,
    logContainer,
    startDockerMonitor,
    waitContainer,
    saveContainerLogs
}
