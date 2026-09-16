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
 * XChain Node - Docker Service: Environment Checks
 * Host checks for docker, buildkit, memory limits and the containerd data-root
 ********************************************************************/

const { execFile } = require('child_process')
const fs          = require('fs')

const config = require('../../config');

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

// Every xchain service Dockerfile carries an optional COPY written as a glob
// (`COPY ./.en[v] ...`, and the explorer's `COPY ./xchain-v[m] ...`). BuildKit
// treats a glob that matches nothing as a no-op; Docker's legacy builder
// rejects it with "COPY failed: no source files were specified". A host whose
// `docker build` falls to the legacy builder (Ubuntu's `docker.io` package
// ships no buildx plugin; so does an exported DOCKER_BUILDKIT=0) therefore
// fails every module install after the clone and the DB provisioning have
// already run (xchain-hub issue 23, a fresh Ubuntu 24.04 validator). Probe
// for buildx before the build so the failure names the missing package
// instead of a COPY line inside a module the operator did not write.
async function checkBuildKitAvailable() {
    return new Promise((resolve, reject) => {
        execFile('docker', ['buildx', 'version'], (error) => {
            if (error) {
                reject("Docker's buildx plugin is not installed, so `docker build` would fall back to the "
                    + "legacy builder, which cannot build the xchain module images. Install it and retry: "
                    + "`sudo apt install docker-buildx-plugin` (see INSTALL.md, \"Install docker engine\").")
                return
            }
            resolve(true)
        })
    })
}

// Whether this host can enforce a container memory limit at all.
//
// A kernel built without the memory cgroup controller, or booted with it off
// (Raspberry Pi OS is the common case), does not refuse `docker run --memory`:
// it accepts the flag, warns on stderr, and creates the container with no limit.
// Docker knows perfectly well that it cannot do it, and says so in the warnings
// `docker info` carries, which is one cheap question asked once before any
// container is created rather than N surprises afterwards.
//
// A DIAGNOSTIC only, and best-effort in both directions: any failure to ask
// (no docker, an older daemon with no Warnings field, output that is not JSON)
// resolves null and the command proceeds exactly as it did before.
//
// Returns the warning line Docker gave, or null when memory limits are supported
// or the question could not be asked.
async function checkMemoryLimitSupport() {
    return new Promise((resolve) => {
        execFile('docker', ['info', '--format', '{{json .Warnings}}'], (error, stdout) => {
            if (error || !stdout || !stdout.trim()) {
                resolve(null)
                return
            }
            try {
                const warnings = JSON.parse(stdout.trim())
                if (!Array.isArray(warnings)) {
                    resolve(null)
                    return
                }
                // "WARNING: No memory limit support" is the line. The neighbouring
                // swap-limit warning is a different (and survivable) shortfall, so
                // match the memory phrase rather than any limit warning.
                const hit = warnings.find(w => /memory limit/i.test(String(w)))
                resolve(hit ? String(hit) : null)
            } catch {
                resolve(null)
            }
        })
    })
}

// When an operator relocates Docker's data-root off the root
// filesystem (the common "move Docker to a big NVMe/HDD" recipe: set
// `"data-root": "/misc/docker"` in /etc/docker/daemon.json), Docker's own
// image + overlay2 store moves with it, but the containerd content and
// snapshot store at /var/lib/containerd does NOT: that setting never touches
// containerd's root. The containerd store keeps growing on the (often small)
// root filesystem and can silently fill `/`, wedging the whole box even though
// the operator believes storage lives on the big disk.
//
// This is a DIAGNOSTIC only, never automation: relocating containerd means
// editing /etc/containerd/config.toml (or bind-mounting /var/lib/containerd)
// and restarting the containerd + docker daemons, which is far too disruptive
// to perform silently from a precheck. It is fully best-effort: any probe
// failure resolves to null so a command is never blocked by it.
//
// Returns { dockerRootDir, containerdRoot } when Docker's data-root sits on a
// different filesystem than `/` while containerd's store is still on `/`
// (the disk-fill hazard), otherwise null.
async function checkContainerdDataRootRelocation() {
    return new Promise((resolve) => {
        execFile('docker', ['info', '--format', '{{.DockerRootDir}}'], (error, stdout) => {
            if (error || !stdout || !stdout.trim()) {
                resolve(null)
                return
            }
            const dockerRootDir  = stdout.trim()
            // Default containerd root on Debian/Ubuntu Docker installs; overridable
            // for non-standard installs (or to silence a false positive when
            // containerd was already relocated to a path we can't infer).
            const containerdRoot = config.XCHAIN_NODE_CONTAINERD_ROOT
            try {
                const rootDev = fs.statSync('/').dev
                let dockerRootDev
                try {
                    dockerRootDev = fs.statSync(dockerRootDir).dev
                } catch {
                    // data-root path unreadable/missing: can't judge relocation.
                    resolve(null)
                    return
                }
                // Docker data-root still on the root filesystem: nothing was
                // relocated, so containerd staying on `/` is expected and fine.
                if (dockerRootDev === rootDev) {
                    resolve(null)
                    return
                }
                // Data-root has moved off `/`. Is containerd's store still on `/`?
                let containerdDev
                try {
                    containerdDev = fs.statSync(containerdRoot).dev
                } catch {
                    // No containerd dir present (or unreadable): nothing to warn about.
                    resolve(null)
                    return
                }
                if (containerdDev === rootDev) {
                    resolve({ dockerRootDir, containerdRoot })
                    return
                }
                // containerd already lives off `/` (same disk as data-root or a
                // third mount): no root-fill hazard.
                resolve(null)
            } catch {
                resolve(null)
            }
        })
    })
}

module.exports = {
    checkDockerInstalledAndReachable,
    checkBuildKitAvailable,
    checkMemoryLimitSupport,
    checkContainerdDataRootRelocation
}
