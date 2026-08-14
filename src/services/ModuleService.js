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
 * XChain Node - Module Service
 * Clone, build, install and uninstall XChain modules
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const fs        = require('fs')

const path = require('path')
const {
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    XChainService, SEP, modulesUrls, LIBRARY_BUNDLES, SERVICE_REGISTRY, DEFAULT_MODULE_BRANCH
} = require('../config/constants')
const { db }                = require('../state')
const {
    getModuleDir, getModuleTmpDir, moduleDirExists, checkIfModuleExists,
    removeModuleTmpDir, createModuleTmpDir,
    getDockerContainerImageName, getUtxoTrackerVolumeName, getDockerNetwork, getDefaultConfig, validatePort
} = require('./ConfigService')
const { statusChanged, getStatus } = require('./StatusService')
const { killContainer, removeContainer, getPublishedHostPorts, forceRemoveContainerByName } = require('./DockerService')
const { setDatabaseParameters, setHubDatabaseParameters }  = require('./DatabaseService')
const { redactSecrets } = require('../utils/helpers')

// Sibling directories used to make a rewrite-clone atomic-ish (see cloneGit).
// Both live beside the module checkout inside the modules dir, so the two
// renames below stay on one filesystem and cannot fail with EXDEV.
const CLONE_STAGING_SUFFIX  = '.xchain-node-staging'
const CLONE_PREVIOUS_SUFFIX = '.xchain-node-previous'

// Run `git clone` into `destination`. Rejects with the operator-facing string
// the callers already surface; performs no filesystem cleanup of its own so
// the caller owns the rollback decision.
function runGitClone(module, branch, destination) {
    return new Promise((resolve, reject) => {
        const gitUrl = modulesUrls[module]
        const cloneArgs = ['clone']
        if (branch) cloneArgs.push('-b', branch)
        // Local-path sources (no ':' i.e. not a URL/SCP-style remote) on the
        // Parallels share can't hardlink between the two trees, so force
        // a copy instead of git's default object-linking.
        if (gitUrl && gitUrl.startsWith('/')) cloneArgs.push('--no-hardlinks')
        cloneArgs.push(gitUrl, destination)

        execFile('git', cloneArgs, (error, stdout, stderr) => {
            if (error) {
                if (branch && stderr && stderr.toLowerCase().includes('not found')) {
                    // Do NOT silently fall back to the default branch: install/update
                    // callers pass `branch` as an explicit operator request (cli.js),
                    // and running different code than what was asked for with only a
                    // scrolling console.warn is a silent-wrong-code hazard
                    // (uuid:4f649bd0). Fail the clone instead.
                    //
                    // The hint matters because the mechanism is routinely misread:
                    // install/update clone from the module's REMOTE, so a branch that
                    // exists only in the checkout on this box is invisible here. Push
                    // it, or point the module at a local path with
                    // XCHAIN_NODE_MODULES_URLS_OVERRIDE.
                    reject(`Error cloning project: branch '${branch}' not found for module '${module}'`
                        + ` (clones come from the module's remote, so a branch that exists only in the`
                        + ` local checkout is not visible: push it, or set`
                        + ` XCHAIN_NODE_MODULES_URLS_OVERRIDE='{"${module}":"/path/to/local/checkout"}')`)
                } else {
                    reject("Error cloning project: " + redactSecrets(error.message))
                }
            } else {
                resolve(true)
            }
        })
    })
}

// Clone-integrity check for a pinned install (release-management spec section 11).
//
// The manifest records each component's tag AND the commit that tag pointed at
// when the train was cut, because a tag is mutable by whoever owns the repo: it
// can be deleted and re-pushed at different content, and a clone of `-b v0.9.0`
// would follow it without complaint. Verifying the checked-out commit is what
// turns "we asked for v0.9.0" into "we are running the reviewed v0.9.0", and it
// extends the SHA-256 discipline github_hashes.json already applies to
// downloaded coin-daemon binaries to the git-cloned half of the stack.
//
// Throws on mismatch; the caller owns cleanup and must not leave the mismatched
// tree in place.
async function assertCheckoutCommit(module, dir, expectedCommit) {
    if (!expectedCommit) return

    let head
    try {
        const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])
        head = stdout.trim()
    } catch (err) {
        throw new Error(`Could not read the cloned commit for '${module}': ${redactSecrets(String(err && err.message ? err.message : err))}`)
    }

    if (head !== expectedCommit) {
        throw new Error(
            `Clone integrity check FAILED for '${module}': the release manifest pins`
            + ` ${expectedCommit} but the clone checked out ${head}.`
            + ` The tag has moved since the release was cut, or the remote is not the`
            + ` repository the manifest was written against. Nothing has been installed.`
        )
    }
}

// Identity of a checkout: the commit an operator would have to name to
// reproduce this exact tree, plus enough context to recognise an old one at a
// glance. Returns nulls instead of throwing, because reporting which code is
// being deployed must never be the thing that fails a deploy.
async function readCheckoutIdentity(dir) {
    const unknown = { commit: null, committedAt: null, subject: null }
    try {
        const { stdout } = await execFileAsync('git', ['-C', dir, 'log', '-1', '--format=%H%x1f%cI%x1f%s'])
        const [commit, committedAt, subject] = String(stdout || '').trim().split('\x1f')
        if (!/^[a-f0-9]{40}$/.test(commit || '')) return unknown
        return { commit, committedAt: committedAt || null, subject: subject || null }
    } catch {
        return unknown
    }
}

// The commit and branch a checkout is on, read straight off the git ref files.
//
// Deliberately NOT a `git` subprocess: this runs on the docker-build path, which
// must not gain a new place to block, and the answer it needs (which commit, which
// branch) is two small file reads. Returns nulls for anything it cannot read,
// including a `.git` file (worktree pointer) or a packed-only ref it cannot find.
function readCheckoutIdentityFromDisk(dir) {
    const unknown = { commit: null, ref: null }
    try {
        const gitDir = path.join(dir, '.git')
        const head = String(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8') || '').trim()
        if (/^[a-f0-9]{40}$/.test(head)) return { commit: head, ref: null }

        const match = head.match(/^ref:\s*(\S+)$/)
        if (!match) return unknown
        const refName = match[1]
        const shortRef = refName.replace(/^refs\/heads\//, '')

        try {
            const loose = String(fs.readFileSync(path.join(gitDir, refName), 'utf8') || '').trim()
            if (/^[a-f0-9]{40}$/.test(loose)) return { commit: loose, ref: shortRef }
        } catch { /* ref is packed, not loose; fall through */ }

        const packed = String(fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8') || '')
        for (const line of packed.split('\n')) {
            const parts = line.trim().split(/\s+/)
            if (parts.length === 2 && parts[1] === refName && /^[a-f0-9]{40}$/.test(parts[0])) {
                return { commit: parts[0], ref: shortRef }
            }
        }
        return unknown
    } catch {
        return unknown
    }
}

// The commit a source repository's BRANCH points at right now. `git ls-remote`
// speaks the same protocol for an ssh/https remote and for a local path, which
// is what lets one oracle cover both clone sources.
//
// Returns null when the ref is not a branch there (a tag, a pinned install) or
// the query fails (offline, auth, no such remote): "could not verify" has to
// degrade to a warning, never to a refused deploy.
async function readSourceBranchTip(url, branch) {
    try {
        const { stdout } = await execFileAsync('git', ['ls-remote', url, 'refs/heads/' + branch])
        const line = String(stdout || '').split('\n').find(l => l.trim().length > 0)
        if (!line) return null
        const sha = line.trim().split(/\s+/)[0]
        return /^[a-f0-9]{40}$/.test(sha) ? sha : null
    } catch {
        return null
    }
}

// A source that is a filesystem path rather than a remote URL. Matches the same
// shapes runGitClone already treats as local (a leading '/'), plus explicit
// relative prefixes; anything else is an ssh/https remote as far as this goes.
// A false negative only costs the extra diagnosis below, never correctness.
function isLocalPathSource(url) {
    return typeof url === 'string' && (url.startsWith('/') || url.startsWith('./') || url.startsWith('../'))
}

// A local-path source (the XCHAIN_NODE_MODULES_URLS_OVERRIDE workflow) is cloned
// through its OWN refs, so `-b master` deploys THAT checkout's master, not the
// upstream's. When the checkout is behind its own origin the deploy is quietly
// older than the branch the operator named, and nothing downstream can tell:
// the container comes up healthy, and the module's package.json version is the
// same string it was dozens of commits ago.
//
// Warn rather than refuse: deploying local work that is not upstream yet is the
// entire point of the override, so being behind is legitimate, just never
// something an operator should discover after measuring the wrong tree.
async function warnIfSourceBranchIsBehind(module, url, branch) {
    if (!isLocalPathSource(url)) return
    try {
        const revParse = async (ref) => {
            const { stdout } = await execFileAsync('git', ['-C', url, 'rev-parse', '--verify', '--quiet', ref])
            return String(stdout || '').trim()
        }
        const local    = await revParse('refs/heads/' + branch)
        const upstream = await revParse('refs/remotes/origin/' + branch)
        if (!local || !upstream || local === upstream) return
        const { stdout } = await execFileAsync('git', ['-C', url, 'rev-list', '--count', local + '..' + upstream])
        const behind = parseInt(String(stdout || '').trim(), 10)
        if (!(behind > 0)) return
        console.warn(`WARNING: '${module}' is being deployed from the local checkout ${url},`
            + ` whose '${branch}' is ${behind} commit(s) BEHIND its own origin/${branch}`
            + ` (${local.slice(0, 12)} vs ${upstream.slice(0, 12)}).`
            + ` The deploy will contain the older tree; fetch that checkout if you meant the upstream branch.`)
    } catch { /* best-effort diagnosis; never blocks a deploy */ }
}

// Prove a freshly cloned checkout is the code the operator asked for.
//
// assertCheckoutCommit answers "is this the reviewed commit" for a manifest pin.
// This answers the question a NAMED BRANCH raises and nothing used to ask: is
// this what that branch points at NOW. Every deploy signal the platform had
// (package.json version, image tag, container uptime, `docker ps` health) is
// satisfied by a stale tree, so a branch that resolves to an old commit ships
// silently and an acceptance test then measures code that was never deployed.
//
// A disagreement is re-cloned ONCE (a push landing between the clone and the
// check is a real race, not a bug) and refused after that, so any source that
// resolves a branch to something other than its tip fails loudly instead.
async function verifyDeploySource(module, branch, dir, expectedCommit) {
    // A pinned install names a commit and assertCheckoutCommit already proved it;
    // a tag is not a branch, so there is no tip to compare against either.
    if (expectedCommit || !branch) return

    const url = modulesUrls[module]
    await warnIfSourceBranchIsBehind(module, url, branch)

    const tip = await readSourceBranchTip(url, branch)
    if (!tip) return

    let head = (await readCheckoutIdentity(dir)).commit
    if (!head || head === tip) return

    console.warn(`WARNING: the clone of '${module}' landed on ${head.slice(0, 12)} but`
        + ` '${branch}' points at ${tip.slice(0, 12)} in the source. Re-cloning once.`)
    fs.rmSync(dir, { recursive: true, force: true })
    await runGitClone(module, branch, dir)
    head = (await readCheckoutIdentity(dir)).commit
    if (head === tip) return

    throw new Error(
        `Stale source for '${module}': the clone resolved '${branch}' to ${head ? head.slice(0, 12) : 'an unreadable commit'}`
        + ` twice, but '${branch}' points at ${tip.slice(0, 12)}. Nothing has been deployed.`
        + ` Deploying this would have produced a container that reports the right version while running older code.`
    )
}

// Say which commit a module is being deployed from, every time, unprompted.
//
// This is the line whose absence cost real evidence: a redeploy that shipped a
// 13-hour-old commit looked identical to a correct one, because the only things
// printed were the module name and a version string that had not changed in
// weeks. The commit and its date make an old tree obvious at the moment it is
// deployed rather than after a test has measured it.
async function reportDeployedSource(module, dir, branch) {
    const { commit, committedAt, subject } = await readCheckoutIdentity(dir)
    const url = redactSecrets(String(modulesUrls[module] || 'unknown source'))
    if (!commit) {
        console.log(`Deploy source for '${module}': commit UNKNOWN (not a git checkout?) from ${url}`)
        return
    }
    console.log(`Deploy source for '${module}': ${commit} (${branch || 'default branch'})`
        + ` committed ${committedAt || 'at an unknown time'}`
        + (subject ? ` "${subject}"` : '')
        + ` from ${url}`)
}

// Clone a module's source into its deploy checkout.
//
// A clone that would replace an EXISTING checkout is staged in a sibling
// directory and swapped in only once git has succeeded. The previous
// implementation deleted the destination as its first step, so any clone
// failure (a branch absent from the remote, a network drop, an auth refusal)
// left the module directory simply gone: on a live install, an `update
// xchain-hub ... <branch>` destroyed the deploy source including a
// local-only hotfix branch, and because the running container was untouched
// nothing surfaced the loss. Validation of the module URL and the branch
// name also moved ahead of every filesystem mutation for the same reason.
//
// Failure semantics: on any error the pre-existing checkout is still in place
// and unmodified, and the error is thrown (never an unhandled rejection). That
// includes a failed `expectedCommit` check: it runs against the STAGING tree,
// before the swap, so a moved tag cannot replace a good checkout with a bad one.
async function cloneGit(module, rewrite = false, useTmp = false, branch = null, expectedCommit = null) {
    if (!(module in modulesUrls)) {
        throw "module doesn't have an url"
    }

    if (branch && !/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
        throw "Invalid branch name: " + branch + " (branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes)"
    }

    // The tmp tree is scratch space (version probes, the skew guard) that is
    // rebuilt on every use and holds nothing unrecoverable, so it keeps the
    // cheap wipe-then-clone shape.
    if (useTmp) {
        removeModuleTmpDir(module)
        createModuleTmpDir(module)
        const tmpDir = getModuleTmpDir(module)
        const cloned = await runGitClone(module, branch, tmpDir)
        try {
            await assertCheckoutCommit(module, tmpDir, expectedCommit)
        } catch (err) {
            removeModuleTmpDir(module)
            throw err
        }
        return cloned
    }

    const destination = getModuleDir(module)

    if (!moduleDirExists(module)) {
        const cloned = await runGitClone(module, branch, destination)
        try {
            await assertCheckoutCommit(module, destination, expectedCommit)
            await verifyDeploySource(module, branch, destination, expectedCommit)
        } catch (err) {
            // Nothing pre-existed here, so removing the bad tree restores the
            // starting state exactly.
            fs.rmSync(destination, { recursive: true, force: true })
            throw err
        }
        await reportDeployedSource(module, destination, branch)
        return cloned
    }

    if (!rewrite) {
        throw "Module directory already exists"
    }

    const staging  = destination + CLONE_STAGING_SUFFIX
    const previous = destination + CLONE_PREVIOUS_SUFFIX
    // Clear leftovers from an interrupted earlier swap before reusing the names.
    fs.rmSync(staging,  { recursive: true, force: true })
    fs.rmSync(previous, { recursive: true, force: true })

    try {
        await runGitClone(module, branch, staging)
        await assertCheckoutCommit(module, staging, expectedCommit)
        await verifyDeploySource(module, branch, staging, expectedCommit)
    } catch (err) {
        fs.rmSync(staging, { recursive: true, force: true })
        throw err
    }

    // Swap: move the live checkout aside, move the new one in, then drop the
    // old one. Only the middle rename can leave the destination missing, and
    // it is immediately undone below.
    try {
        fs.renameSync(destination, previous)
    } catch (err) {
        fs.rmSync(staging, { recursive: true, force: true })
        throw "Error replacing module checkout for '" + module + "': " + redactSecrets(String(err && err.message ? err.message : err))
            + " (the existing checkout was left in place)"
    }

    try {
        fs.renameSync(staging, destination)
    } catch (err) {
        try {
            fs.renameSync(previous, destination)
        } catch { /* nothing else to try; the original is at `previous` */ }
        fs.rmSync(staging, { recursive: true, force: true })
        throw "Error replacing module checkout for '" + module + "': " + redactSecrets(String(err && err.message ? err.message : err))
    }

    fs.rmSync(previous, { recursive: true, force: true })
    await reportDeployedSource(module, destination, branch)
    return true
}

async function getModuleBranch(module) {
    const dir = getModuleDir(module)
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim()
}

// The exact commit a module checkout sits on. Unlike getModuleBranch this is
// meaningful on a detached HEAD, which is what a pinned (tag) install produces.
async function getModuleCommit(module) {
    try {
        const { stdout } = await execFileAsync('git', ['-C', getModuleDir(module), 'rev-parse', 'HEAD'])
        return stdout.trim()
    } catch {
        return null
    }
}

/**
 * Decide which ref a bundled library is staged at for `module`'s build context.
 *
 * Precedence, and the reason for it:
 *   1. The active release manifest's pin. A pinned install pins EVERYTHING it
 *      stages, or it is not a pinned install.
 *   2. The ref the parent module is checked out at. Staging a library from a
 *      different branch than the service it is being compiled into is a
 *      version-skew bug wearing a build step's clothing, so the library
 *      inherits rather than floats. This is what makes `install develop
 *      xchain-indexer` stage develop's xchain-vm and `install master ...`
 *      stage master's, with no manifest involved.
 *   3. The platform default branch, only when the parent is on a detached HEAD
 *      with no manifest to consult (a hand-checked-out tag, mid-ceremony
 *      testing). Announced, because it is the one path that can still stage a
 *      library the operator did not name.
 *
 * @returns {Promise<{ref:string, commit:string|null, pinned:boolean, reason:string}>}
 */
async function resolveBundledLibRef(module, lib) {
    const { resolveComponentRef } = require('./ReleaseManifestService')

    const pinned = resolveComponentRef(lib, null)
    if (pinned.pinned) {
        return { ref: pinned.ref, commit: pinned.commit, pinned: true, reason: 'release manifest' }
    }

    let parentRef = null
    try {
        parentRef = await getModuleBranch(module)
    } catch { /* module not checked out yet; fall through */ }

    if (parentRef && parentRef !== 'HEAD') {
        return { ref: parentRef, commit: null, pinned: false, reason: `inherited from ${module}` }
    }

    console.warn(`Bundled library ${lib}: ${module} is on a detached HEAD and no release`
        + ` manifest is active, so the library cannot inherit a ref.`
        + ` Falling back to '${DEFAULT_MODULE_BRANCH}'.`)
    return { ref: DEFAULT_MODULE_BRANCH, commit: null, pinned: false, reason: 'default branch fallback' }
}

// Fail fast on host-port collisions before `docker run`. On a single-stack
// host this is a no-op; on a multi-stack host (two NODE_PREFIX stacks, or a
// service container hand-created outside xchain-node) two containers can request
// the same host port, which `docker run` only surfaces as a cryptic "port is
// already allocated" AFTER the image build wastes minutes. `selfName` is the
// container we're (re)creating (excluded so re-installs/updates of the same
// service don't flag themselves; the old container is already killed+removed
// before this runs, but the name-exclusion is belt-and-suspenders).
async function assertNoHostPortConflicts(portArgs, selfName) {
    const requested = []
    for (let i = 0; i < portArgs.length; i++) {
        if (portArgs[i] === '-p') {
            const pair = portArgs[i + 1]
            if (typeof pair !== 'string') continue
            const colonIdx = pair.lastIndexOf(':')
            if (colonIdx === -1) continue
            // "-p HOST:CONTAINER" or "-p IP:HOST:CONTAINER": the host port is the
            // field before the final colon; take the last colon-separated pair's left side.
            const beforeContainer = pair.substring(0, colonIdx)
            const hostPort = beforeContainer.substring(beforeContainer.lastIndexOf(':') + 1)
            if (/^\d+$/.test(hostPort)) requested.push(hostPort)
        }
    }
    if (requested.length === 0) return

    const published = await getPublishedHostPorts()
    const conflicts = []
    for (const hostPort of requested) {
        const holders = published.get(hostPort)
        if (!holders) continue
        const others = [...holders].filter(n => n !== selfName)
        if (others.length > 0) conflicts.push({ hostPort, holders: others })
    }
    if (conflicts.length > 0) {
        const lines = conflicts.map(c => `  host port ${c.hostPort} is already published by: ${c.holders.join(', ')}`)
        throw new Error(
            'Host port conflict: cannot publish the following port(s):\n' +
            lines.join('\n') + '\n' +
            'Another stack or container already binds them on this host. Override the colliding ' +
            'port(s) in config/<coin>-<network> (e.g. EXPLORER_PORT_HTTP/HTTPS, INDEXER_PORT, HUB_PORT, ' +
            'DECODER_PORT, ENCODER_PORT, UTXO_TRACKER_PORT, SYNC_PORT) and re-run, or stop the conflicting container first.'
        )
    }
}

// Per-service healthcheck descriptors.
// Each entry specifies how Docker should probe container readiness:
//   portKey   - the env-var name whose value is the container-internal port to probe
//   probe     - 'http_get' uses wget GET on `path` (default /status); 'jsonrpc_ping'
//               uses wget POST with a JSON-RPC ping payload; absent means no
//               healthcheck added
//   path      - http_get only: route to probe. Defaults to /status. Set it for
//               services whose /status is expensive: sync's /status runs a
//               SELECT COUNT(*) census over every replicated table, which on a
//               heavy multi-chain host (LTC+DOGE) takes longer than the
//               5s timeout and marks a correctly-serving container UNHEALTHY.
//               Sync's /health is O(1) liveness (circuit-breaker +
//               poll-error state, no table scans) and still 503s when the
//               replicator is genuinely wedged, so the probe measures liveness
//               rather than a full table census. The decoder sets it for the
//               opposite reason: its /status is cheap but too NARROW to be a
//               liveness probe (process-alive + DB-reachable only), so a block
//               loop retrying one height forever kept answering 200 and autoheal,
//               which reads nothing but Health.Status, never fired. Its /live
//               route is /status plus the stall check.

//   interval  - how often Docker reruns the check (--health-interval)
//   timeout   - per-check timeout (--health-timeout)
//   retries   - consecutive failures before marking unhealthy (--health-retries)
//   startPeriod - grace period after container start before failures count
//                 (--health-start-period); set long enough for npm start + DB connect
//   autoheal  - opt-in flag consumed by AutohealService/`xchain-node autoheal`:
//               when true, a container that stays unhealthy past the grace window
//               gets `docker restart`ed. Default OFF. Only set it where a restart
//               plausibly clears the wedge (stalled event loop, dead DB pool).
//               NEVER set it on xchain-utxo-tracker: that service deliberately
//               enters a stable halted state (503 while halted) instead of
//               exiting, and a restart would just re-enter the same halt.
//
// Timing rationale:
//   interval=15s  - frequent enough to detect a stuck service quickly without hammering
//   timeout=5s    - generous but short of the interval; covers a slow DB query
//   retries=3     - three misses (~45s) before marking unhealthy; avoids flapping
//   startPeriod=  - varies: fast workers (encoder) get 30s; DB-dependent services
//                   (decoder, indexer, utxo-tracker, miner) get 60s; hub/explorer get
//                   45s; sync gets its own hub-wait window, see its line below. A
//                   service whose probe judges a startup step must grant a window
//                   at least as long as that step, or the probe reports the startup
//                   itself as a failure.
const SERVICE_HEALTHCHECK = {
    [XChainService.XCHAIN_DECODER]:       { portKey: 'DECODER_API_PORT',       probe: 'http_get',     path: '/live', interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s', autoheal: true },
    [XChainService.XCHAIN_ENCODER]:       { portKey: 'ENCODER_API_PORT',       probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '30s', autoheal: true },
    [XChainService.XCHAIN_UTXO_TRACKER]:  { portKey: 'UTXO_TRACKER_API_PORT',  probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    [XChainService.XCHAIN_INDEXER]:       { portKey: 'INDEXER_API_PORT',        probe: 'http_get',     interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s', autoheal: true },
    // The miner's API is JSON-RPC only (no GET /status route); an http_get probe 500s
    // on every check and marks the container permanently unhealthy. It probes `health`
    // rather than `ping` because ping always answers 200 and carries wallet readiness
    // in its body only, so a miner stalled on credential drift or an unreachable coin
    // node stayed healthy here; startPeriod widened to cover wallet prep,
    // which the probe now judges instead of ignoring.
    [XChainService.XCHAIN_REGTEST_MINER]: { portKey: 'REGTEST_MINER_API_PORT',  probe: 'jsonrpc_health', interval: '15s', timeout: '5s', retries: 3, startPeriod: '60s' },
    // The hub probes `health`, not `ping`: ping is a bare SELECT 1, while health 503s
    // on a tripped DB breaker, a stale oracle round, and consensus-input alerting. A
    // hub that had stopped producing usable consensus data read healthy through the
    // narrow probe. Deliberately no autoheal: oracle staleness is usually
    // upstream, where a restart flaps the container and disrupts in-flight rounds.
    [HUB_MODULE_NAME]:                    { portKey: 'HUB_PORT',                probe: 'jsonrpc_health', interval: '15s', timeout: '5s', retries: 3, startPeriod: '45s' },
    [EXPLORER_MODULE_NAME]:               { portKey: 'EXPLORER_API_PORT_HTTP',  probe: 'jsonrpc_ping', interval: '15s', timeout: '5s', retries: 3, startPeriod: '45s' },
    // sync's startPeriod covers MAX_HUB_WAIT_MS (xchain-sync/src/config.js, default
    // 300000ms), not just process boot: /health answers 503 'starting' for the
    // whole hub wait instead of reporting healthy with zero pollers running, and
    // at 45s + 3x15s the container would have flipped UNHEALTHY at ~90s on any
    // stack whose hub takes longer to come up. Docker ends the start period on
    // the first passing check, so the wider window costs nothing once sync is up;
    // a hub that never arrives is still caught by _waitForHub exiting non-zero at
    // MAX_HUB_WAIT_MS. Widen both together if MAX_HUB_WAIT_MS is raised.
    [SYNC_MODULE_NAME]:                   { portKey: 'SYNC_API_PORT',           probe: 'http_get',     path: '/health', interval: '15s', timeout: '5s', retries: 3, startPeriod: '300s' }
    // xchain-e2e-test: one-shot execution container, never gets --restart, healthcheck not applicable
    // coin nodes (node module): managed by NodeService / crypto_nodes; not built via buildAndUp,
    //   so buildHealthcheckArgs never runs for them. Their probe is BAKED INTO THE IMAGE instead
    //   (HEALTHCHECK in crypto_nodes/<coin>/Dockerfile, an RPC getblockchaininfo ping), which is
    //   why there is no entry here. Deliberately no autoheal either, mirroring the utxo-tracker
    //   line above: a wedged daemon usually means corrupt state a blind restart re-enters.
    // database (mariadb): managed by DatabaseService with its own health tooling
}

// Build the --health-* flags for a service container's docker run invocation.
// Returns an empty array when no healthcheck is configured for the module
// (or when the required port env-var is missing), so callers are always safe.
// Resolve the healthcheck grace window, allowing a per-service env override.
// A fresh install starts the container (with this window already counting down)
// and THEN restores its bootstrap archive -- installModule runs
// ensureBootstrapUtxoTracker / ensureBootstrapMariaDb AFTER buildAndUp -- which
// on a large chain takes many minutes, far past the default 60s startPeriod, so
// the container is marked cosmetically unhealthy mid-restore. An install
// holds the command lock, which already keeps `autoheal` from firing (no watchdog
// restart mid-restore), but operators expecting a long restore can widen the
// Docker grace window via XCHAIN_NODE_HEALTH_START_PERIOD_<SERVICE> (service
// upper-cased, non-alnum -> underscore), e.g.
// XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER=900s. Accepts a value with
// an ms/s/m/h unit, or bare seconds (900), which is normalized to '900s' before
// it reaches docker: --health-start-period is parsed by Go's time.ParseDuration,
// which rejects a unitless number ("missing unit in duration") and fails the
// whole `docker run`, so the documented bare-seconds form must never be passed
// through verbatim. Anything else is ignored and the descriptor default stands.
function resolveStartPeriod(module, fallback) {
    const key = 'XCHAIN_NODE_HEALTH_START_PERIOD_'
        + String(module).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    const raw = process.env[key]
    if (!raw) return fallback
    const value = raw.trim()
    if (/^\d+(ms|s|m|h)$/.test(value)) return value
    if (/^\d+$/.test(value)) return value + 's'
    // Malformed override: say so rather than silently standing on the default,
    // mirroring the loud-drift guard in buildHealthcheckArgs below.
    console.log("WARNING: ignoring " + key + "=" + value
        + ": expected bare seconds (900) or a duration with an ms/s/m/h unit (900s)")
    return fallback
}

function buildHealthcheckArgs(module, environmentVariables) {
    const hc = SERVICE_HEALTHCHECK[module]
    if (!hc) return []

    const port = environmentVariables[hc.portKey]
    if (!port) {
        // Every descriptor's portKey currently ships in ConfigService.getDefaultConfig,
        // so this guard should never fire. If a future rename or config regression drops
        // the key, the container would otherwise be created with NO healthcheck and no
        // trace of why: make that drift loud at install/update time. Empty-array return
        // is preserved so callers stay safe.
        console.log("WARNING: no healthcheck for " + module + ": env " + hc.portKey + " is unset")
        return []
    }

    let cmd
    if (hc.probe === 'jsonrpc_ping' || hc.probe === 'jsonrpc_health') {
        // JSON-RPC POST; hub, explorer, and the regtest miner all speak this protocol.
        // `ping` is bare liveness (a SELECT 1, or "the port answers"); `health` is the
        // richer verdict that 503s on a service that is up but no longer making
        // progress, and wget -qO- exits non-zero on that 503 exactly as it does on a
        // dead port. Pick per descriptor: a service whose ping already carries the
        // real verdict (explorer) stays on ping.
        const method = hc.probe === 'jsonrpc_health' ? 'health' : 'ping'
        cmd = `wget -qO- --post-data='{"jsonrpc":"2.0","method":"${method}","id":1}' --header='Content-Type: application/json' http://localhost:${port}/ || exit 1`
    } else {
        // Default: plain HTTP GET on /status; descriptors override via `path`
        // where /status is too expensive to double as a liveness probe (sync).
        cmd = `wget -qO- http://localhost:${port}${hc.path || '/status'} || exit 1`
    }

    return [
        '--health-cmd',      cmd,
        '--health-interval', hc.interval,
        '--health-timeout',  hc.timeout,
        '--health-retries',  String(hc.retries),
        '--health-start-period', resolveStartPeriod(module, hc.startPeriod)
    ]
}

// Build the per-service docker-run port/volume/ulimit args from the
// table-driven SERVICE_REGISTRY (constants.js) instead of a hand-maintained
// switch/case. A module with no `docker` facet (or no registry entry, e.g.
// the one-shot e2e-test runner) yields empty arg arrays. `singleton` tells the
// caller to clear coin/network before container-name and network resolution
// (shared hub/explorer/sync containers). Preserves the previous exact
// semantics: `always` ports push unconditionally, other ports push only when
// both env keys are present, and the two hub-only dynamic mounts (validator
// capability config, operator signer dir) resolve here where ValidatorService
// and the filesystem are available.
function buildModuleDockerArgs(module, environmentVariables, coin, network) {
    const portArgs = []
    const volumeArgs = []
    const ulimitArgs = []
    const docker = (SERVICE_REGISTRY[module] || {}).docker
    if (!docker) return { portArgs, volumeArgs, ulimitArgs, singleton: false }

    for (const p of docker.ports || []) {
        if (p.always || (p.host in environmentVariables && p.container in environmentVariables)) {
            portArgs.push('-p', `${environmentVariables[p.host]}:${environmentVariables[p.container]}`)
        }
    }

    for (const v of docker.volumes || []) {
        if (v.hostKey) {
            volumeArgs.push('-v', `${environmentVariables[v.hostKey]}:${v.container}`)
        } else if (v.hostFn === 'utxoTrackerVolume') {
            // Volume name derivation lives in one place (ConfigService), consumed
            // here and by resetModules + BootstrapService, so a non-default
            // NODE_PREFIX can never drift between them (uuid:7523dd94, uuid:a61fc673).
            volumeArgs.push('-v', `${getUtxoTrackerVolumeName(coin, network)}:${v.container}`)
        } else if (v.type === 'hubCapabilityConfig') {
            // Validator mode: mount the capability config (read-only) so the
            // hub's HUB_CAPABILITY_CONFIG path resolves inside the container.
            // No-op for a standalone hub (no validator configured).
            //
            // The DIRECTORY holding capabilities.json is what gets mounted, not
            // the file. A single-file bind mount permanently breaks `docker cp`
            // against this container - Docker recreates each mount destination
            // as a directory during a copy, collides with the file and aborts
            // with "mkdirat validator/capabilities.json: file exists" for EVERY
            // path, not just the mounted one. ValidatorService keeps that
            // directory holding nothing but the capability config, so the
            // validator's signing.key never enters the container.
            if ('HUB_CAPABILITY_CONFIG' in environmentVariables) {
                const { getCapabilityConfigMountDir, CAPS_CONTAINER_DIR } = require('./ValidatorService')
                const capsHostDir = getCapabilityConfigMountDir()
                if (capsHostDir) {
                    volumeArgs.push('-v', `${capsHostDir}:${CAPS_CONTAINER_DIR}:ro`)
                }
            }
        } else if (v.type === 'hubSignerDir') {
            // Operator signer for the on-chain DOGE publishers (PRICE v0 / ANCHOR).
            // The directory carries the operator's signer.js plus its own
            // node_modules and key file, so the whole directory is mounted
            // read-only; ConfigService sets HUB_SIGNER_MODULE to the matching
            // in-container path. No-op when unconfigured.
            if (process.env.XCHAIN_NODE_HUB_SIGNER_DIR && fs.existsSync(process.env.XCHAIN_NODE_HUB_SIGNER_DIR)) {
                volumeArgs.push('-v', `${process.env.XCHAIN_NODE_HUB_SIGNER_DIR}:/XChainHub/operator-signer:ro`)
            }
        }
    }

    for (const u of docker.ulimits || []) {
        ulimitArgs.push('--ulimit', u)
    }

    return { portArgs, volumeArgs, ulimitArgs, singleton: !!docker.singleton }
}

/**
 * Build the module image and (re)create its container from the current config.
 *
 * `options.reuseImage` keeps the image that is already tagged for this container and
 * skips both the bundled-library re-clone and `docker build`. A container freezes its
 * env at `docker run`, so the ONLY way to correct a credential it carries is to
 * recreate it; without this flag that correction also drags in whatever GitHub HEAD
 * holds today, turning a credential repair into an unreviewed version bump.
 *
 * @param {string} module
 * @param {string|null} coin
 * @param {string|null} network
 * @param {string|null} [overwriteContainerId]
 * @param {boolean} [onlyExecution]
 * @param {string[]|null} [dockerCmdArgs]
 * @param {{reuseImage?: boolean}} [options]
 * @returns {Promise<string>} the new container id
 */
async function buildAndUp(module, coin, network, overwriteContainerId = null, onlyExecution = false, dockerCmdArgs = null, options = {}) {
    if (!checkIfModuleExists(module)) {
        throw "module not found"
    }

    const reuseImage = options.reuseImage === true

    const environmentVariables = await getDefaultConfig(module, coin, network)
    const dir = getModuleDir(module)

    // Go-live pre-flight: warns pre-launch, refuses a mainnet write-surface
    // deploy with un-armed settings once XCHAIN_NODE_GO_LIVE=1.
    const { assertGoLiveReady } = require('./GoLiveGate')
    assertGoLiveReady(module, coin, network, environmentVariables, dir)

    // Stage any bundled library modules into this service's build context.
    // The service's Dockerfile COPYs them in and npm resolves the
    // "file:./<lib>" deps recursively at install.
    // Staging exists to feed `docker build`; with reuseImage there is no build, and
    // re-cloning would silently move the module's source off the version the image
    // (and therefore the running container) was made from.
    const bundledLibs = reuseImage ? [] : (LIBRARY_BUNDLES[module] || [])
    for (const lib of bundledLibs) {
        // Always re-clone so bundled-library commits land on every `update`.
        // The previous "clone only if missing" check meant xchain-vm changes
        // got silently ignored on `update xchain-indexer` because the cached
        // modules/xchain-vm dir from a prior run was reused verbatim.
        // cloneGit(rewrite=true) removes any existing dir before cloning.
        //
        // The ref is RESOLVED, never null. Passing null here meant "clone the
        // remote's default branch", which made a bundled library the one part
        // of a pinned install that floated: `install v0.9.0 xchain-indexer`
        // pinned the indexer and then staged whatever xchain-vm's default
        // branch happened to hold, into the consensus-critical VM, inside the
        // image the indexer actually runs. The indexer repo gitignores the
        // staged copy, so no tag pinned it and nothing surfaced the drift.
        // That is a fork vector today and a sharper one once the default
        // branch becomes develop, which is why this lands BEFORE the flip
        // (release-management spec sections 8 and 11).
        const libRef = await resolveBundledLibRef(module, lib)
        console.log(`Cloning bundled library ${lib} for ${module} at ${libRef.ref}`
            + (libRef.pinned ? ` (manifest-pinned ${libRef.commit.slice(0, 12)})` : ` (${libRef.reason})`))
        await cloneGit(lib, true, false, libRef.ref, libRef.commit)
        const libSrc  = getModuleDir(lib)
        const libDest = path.join(dir, lib)
        console.log("Staging " + lib + " into " + module + " build context")
        fs.rmSync(libDest, { recursive: true, force: true })
        fs.cpSync(libSrc, libDest, {
            recursive: true,
            force: true,
            filter: (src) => {
                const base = path.basename(src)
                return base !== "node_modules" && base !== ".git" &&
                       base !== "test" && base !== "bench" && base !== "reports"
            }
        })
    }

    const containerPrefix = getDockerContainerImageName(module, coin, network)

    // Table-driven per-service run-args (SERVICE_REGISTRY in constants.js)
    // replaces the old per-service switch/case: a new service is one table
    // entry, not four hand-edited dispatch sites. Singleton
    // services (hub/explorer/sync) clear coin/network so the shared container
    // name and network resolve correctly below.
    const built = buildModuleDockerArgs(module, environmentVariables, coin, network)
    if (built.singleton) {
        coin = ""
        network = ""
    }
    const portArgs = built.portArgs
    const volumeArgs = built.volumeArgs
    const ulimitArgs = built.ulimitArgs

    // Validate all port values
    if (portArgs.length > 0) {
        for (let i = 0; i < portArgs.length; i++) {
            if (portArgs[i] === '-p') {
                const pair = portArgs[i + 1]
                const colonIdx = pair.indexOf(':')
                if (colonIdx === -1) continue
                const hostPort = pair.substring(0, colonIdx)
                const containerPort = pair.substring(colonIdx + 1)
                if (!validatePort(hostPort) || !validatePort(containerPort)) {
                    throw "Invalid port value in configuration: " + pair
                }
            }
        }
    }

    // Pre-flight host-port collision check (multi-stack hosts), run BEFORE the
    // docker build so a collision fails fast instead of only surfacing after
    // minutes of image build are wasted. Safe to run ahead of the
    // overwrite/teardown below: assertNoHostPortConflicts excludes selfName
    // (containerPrefix) from conflicts by container name regardless of whether
    // the old container has been removed yet.
    await assertNoHostPortConflicts(portArgs, containerPrefix)

    // With no build to make it, the tag has to already exist. Say so here rather
    // than letting `docker run` fall through to a registry pull for an image name
    // that was only ever local, which fails with an unrelated auth/not-found error.
    if (reuseImage) {
        try {
            await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Id}}', containerPrefix])
        } catch {
            throw new Error(
                "No local image tagged " + containerPrefix + " to reuse; run `update " + module +
                (coin && network ? " " + coin + " " + network : "") + "` to build one."
            )
        }
    }

    // Stamp the source commit onto the IMAGE, not just onto a log line that
    // scrolls away. Neither of the two things an operator can read off a running
    // container answers "which code is this": the image tag is a fixed name, and
    // the module's package.json version is a release string that stays put across
    // dozens of commits (xchain-indexer has reported 2.7.17 since 2026-07-17), so
    // both said "correct" about a container running a 13-hour-old tree.
    //
    // A label is the right carrier: it is fixed at build time, inherited by every
    // container created from the image, and left alone by a `recreate` (which
    // reuses the image and must NOT re-stamp it with whatever the checkout holds
    // today, or the stamp would drift into the same lie). Read it back with
    //   docker inspect --format '{{index .Config.Labels "xchain.source.commit"}}' <container>
    const sourceLabels = reuseImage ? { commit: null, ref: null } : readCheckoutIdentityFromDisk(dir)
    const buildLabelArgs = []
    if (sourceLabels.commit) buildLabelArgs.push('--label', 'xchain.source.commit=' + sourceLabels.commit)
    if (sourceLabels.ref)    buildLabelArgs.push('--label', 'xchain.source.ref=' + sourceLabels.ref)

    return new Promise((resolve, reject) => {
        // Pass every container env var as a bare `--env NAME` (value supplied in
        // the execFile `env` option below), NOT `--env NAME=value` in argv. The
        // config map carries per-install secrets (HUB_DB_PASS/DECODER_DB_PASS/
        // INDEXER_DB_PASS, NODE_PASSWORD, HUB_API_KEY/INDEXER_API_KEY, the per-coin
        // *_API_KEY, TELEMETRY_ADMIN_KEY). In argv those would land in
        // /proc/<docker-pid>/cmdline (world-readable, no hidepid) AND in a failed
        // `docker run` error.message (which upstream logging prints, and an operator
        // pastes into a bug report). Mirrors DatabaseService's MYSQL_ROOT_PASSWORD
        // treatment. The value reaches the container identically; only argv changes.
        const envArgs = []
        const dockerEnv = { ...process.env }
        for (const key in environmentVariables) {
            envArgs.push('--env', key)
            dockerEnv[key] = String(environmentVariables[key])
        }

        // Everything from here on is image-independent: tear down the old container
        // and `docker run` the tag. reuseImage enters it directly; the normal path
        // enters it from the build callback.
        const createContainer = async () => {
            try {
                if (overwriteContainerId) {
                    try {
                        await killContainer(overwriteContainerId)
                    } catch { /* container may not be running */ }
                    try {
                        await removeContainer(overwriteContainerId)
                    } catch { /* container may have been removed manually */ }
                }

                // Name-keyed cleanup immediately before `docker run --name`, making
                // (re)creation idempotent against a leftover carcass the registry
                // never recorded: an interrupted onlyExecution run (registry insert
                // skipped, ModuleService.js ~L416), or a container that exists but
                // whose registry insert failed. The overwriteContainerId removal
                // above is id-keyed and misses both cases (uuid:9533ee7a).
                try {
                    await forceRemoveContainerByName(containerPrefix)
                } catch { /* tolerant by design; see DockerService.forceRemoveContainerByName */ }

                // One-shot execution containers (e.g. the e2e-test runner) must NOT get a
                // restart policy: after their command exits, `unless-stopped` would restart
                // them, re-running the suite and leaving the container "restarting" so the
                // subsequent `docker rm` fails. Persistent service containers keep the policy.
                const restartArgs = onlyExecution ? [] : ['--restart', 'unless-stopped']
                // Healthchecks only apply to persistent service containers. One-shot
                // execution containers exit immediately after their command; a healthcheck
                // would fire during the exit window and falsely mark them unhealthy.
                const healthcheckArgs = onlyExecution ? [] : buildHealthcheckArgs(module, environmentVariables)
                // Cap json-file log growth on persistent containers so a
                // long-running node cannot fill the host disk. Sized so the
                // --tail 100 log reader still lands inside a single rotated
                // file. One-shot execution containers exit immediately and
                // need no cap.
                const logOptArgs = onlyExecution ? [] : ['--log-opt', 'max-size=10m', '--log-opt', 'max-file=3']
                const runArgs = [
                    'run', '-d', ...restartArgs, '--name', containerPrefix, '--hostname', containerPrefix,
                    ...logOptArgs,
                    ...volumeArgs,
                    ...ulimitArgs,
                    ...healthcheckArgs,
                    '--network', getDockerNetwork(coin, network),
                    ...envArgs,
                    ...portArgs,
                    '-t', containerPrefix,
                    ...(dockerCmdArgs ?? [])
                ]

                console.log("Creating container of module " + module + (coin && network ? " in " + coin + " " + network : ""))
                execFile('docker', runArgs, { cwd: dir, env: dockerEnv }, async (error2, stdout) => {
                    if (error2) {
                        // error2.message embeds the full argv; redact any secret-shaped
                        // token defensively even though values now live in the child env.
                        reject("Error creating the container: " + redactSecrets(error2.message))
                        return
                    }
                    try {
                        const containerId = stdout.trim()
                        if (/^[a-f0-9]{64}$/.test(containerId)) {
                            if (!onlyExecution) {
                                if (await db.insertModuleContainer(module, coin, network, containerId)) {
                                    await statusChanged()
                                    resolve(containerId)
                                } else {
                                    reject("There was a problem trying to store the container's id")
                                }
                            } else {
                                resolve(containerId)
                            }
                        } else {
                            reject("Invalid container ID returned by Docker: " + containerId)
                        }
                    } catch (err) {
                        reject(err)
                    }
                })
            } catch (err) {
                reject(err)
            }
        }

        if (reuseImage) {
            console.log("Reusing the existing image of module " + module + (coin && network ? " in " + coin + " " + network : ""))
            createContainer()
            return
        }

        console.log("Building image of module " + module + (coin && network ? " in " + coin + " " + network : "")
            + (sourceLabels.commit ? " from " + sourceLabels.commit.slice(0, 12) + " (" + (sourceLabels.ref || 'detached') + ")" : ""))
        execFile('docker', ['build', ...buildLabelArgs, '.', '-t', containerPrefix], { cwd: dir }, (error) => {
            if (error) {
                reject("Error creating Docker image: " + redactSecrets(error.message))
                return
            }
            createContainer()
        })
    })
}

// Singleton modules share one coin/network-independent container name (see
// getDockerContainerImageNamePrefix). DB and EXPLORER have dedicated install
// branches that are already idempotent; HUB and SYNC fall through to the
// generic branch whose "already built?" check is keyed per coin/network, which
// can't see the one shared container, so installing across multiple networks
// would re-run `docker run` with a duplicate name and crash.
const SINGLETON_MODULES = [HUB_MODULE_NAME, SYNC_MODULE_NAME]

// True if a container with this exact name already exists (running or stopped).
// Mirrors getDatabaseContainerId's inspect-by-name probe.
async function containerExistsByName(name) {
    try {
        const { stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', name])
        return /^[a-f0-9]{64}$/.test(stdout.trim())
    } catch {
        return false
    }
}

async function installModule(module, coin, network, remoteUpdate = false, overwriteContainerId = null, onlyExecution = false, branch = null, dockerCmdArgs = null) {
    if (coin === "") coin = null
    if (network === "") network = null

    const { getLocalNodeVersion, getLocalModuleVersion } = require('./VersionService')
    const { getRemoteModuleVersions, getLastStatus }     = require('../state')
    const { buildCryptoNode, getCryptoNode }             = require('./NodeService')
    const { buildDatabaseModule }                        = require('./DatabaseService')
    const { installExplorerModule }                      = require('./ExplorerService')
    const { checkRemoteNodeVersion }                     = require('./VersionService')

    if (module === NODE_MODULE_NAME) {
        const lastStatus = getLastStatus()
        const containerNodeVersion = lastStatus?.[coin ?? ""]?.[network ?? ""]?.[module]?.["container_version"] ?? null

        if (!containerNodeVersion || remoteUpdate) {
            let localNodeVersion = null
            try {
                localNodeVersion = await getLocalNodeVersion(coin, network)
            } catch { /* not installed yet */ }

            if (localNodeVersion == null || remoteUpdate) {
                try {
                    const remoteVersions = getRemoteModuleVersions()
                    if (!(NODE_MODULE_NAME + SEP + coin in remoteVersions)) {
                        await checkRemoteNodeVersion(coin)
                    }
                    const remoteNodeVersion = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]["tag_name"]
                    await getCryptoNode(coin, network, remoteNodeVersion)
                } catch (err) {
                    throw err
                }
            }

            await buildCryptoNode(coin, network)
            await statusChanged()
            return true
        } else {
            return false
        }
    } else if (module === DB_MODULE_NAME) {
        try {
            await buildDatabaseModule(coin, network)
            await statusChanged()
            return true
        } catch (err) {
            throw err
        }
    } else if (module === EXPLORER_MODULE_NAME) {
        try {
            // remoteUpdate=true means the user explicitly ran `update explorer`
            // (or a force-reinstall): bypass the ping/status-row early returns
            // in installExplorerModule and tear down the existing container.
            await installExplorerModule(remoteUpdate)
            await statusChanged()
            return true
        } catch (err) {
            throw err
        }
    } else {
        // For a singleton module the container name is the same for every
        // coin/network, so once it exists this call is a redundant pass for
        // another network in the same install run; skip it (an explicit
        // `update`, remoteUpdate=true, still rebuilds). Without this guard the
        // second network's `docker run` collides on the existing name.
        if (SINGLETON_MODULES.includes(module) && !remoteUpdate) {
            if (await containerExistsByName(getDockerContainerImageName(module, coin, network))) {
                return false
            }
        }

        const lastStatus = getLastStatus()
        const containerNodeVersion = lastStatus?.[coin ?? ""]?.[network ?? ""]?.[module]?.["container_version"] ?? null

        if (!containerNodeVersion || remoteUpdate) {
            let localModuleVersion = null
            try {
                localModuleVersion = await getLocalModuleVersion(module)
            } catch { /* not installed yet */ }

            // Refuse a rotation that would lock a sibling out BEFORE this run
            // re-clones the checkout and buildAndUp tears the old container down.
            // setDatabaseParameters runs the same guard after the rebuild, and by
            // then the working container is already destroyed and restarted on a
            // password the refusal declines to write, so the guard's own "nothing
            // has been changed" promise is broken by the command that makes it
            // (uuid:cb0bd3be). The module being rebuilt is excluded: it comes back
            // on the intended password, so its frozen one is not a lockout.
            // `recreate` does not route through here and stays the remediation,
            // because it converges every named container before provisioning once.
            if ((module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) && !onlyExecution) {
                const { assertNoDbCredentialDrift } = require('./DbCredentialDrift')
                const driftCfg = await getDefaultConfig(XChainService.XCHAIN_INDEXER, coin, network)
                await assertNoDbCredentialDrift(coin, network, {
                    decoder: driftCfg["DECODER_DB_PASS"],
                    indexer: driftCfg["INDEXER_DB_PASS"]
                }, { excludeModules: [module] })
            }

            // Under a pinned install the manifest, not the operator's branch
            // argument, decides this module's ref: `install v0.9.0` means the
            // v0.9.0 component set, and the pinned commit is verified after the
            // clone. Outside a release install `pin.ref` is just `branch` and
            // `pin.commit` is null, so the branch behaviour below is unchanged.
            const { resolveComponentRef } = require('./ReleaseManifestService')
            const pin = resolveComponentRef(module, branch)
            const cloneRef = pin.ref

            try {
                if (remoteUpdate || localModuleVersion == null) {
                    await cloneGit(module, true, false, cloneRef, pin.commit)
                } else if (cloneRef && moduleDirExists(module)) {
                    const currentBranch = await getModuleBranch(module)
                    // A pinned install re-clones whenever the checkout is not
                    // already the pinned commit; a detached checkout reports
                    // "HEAD" as its branch, which would never equal a tag name
                    // and so would re-clone every run without this check.
                    const alreadyThere = pin.pinned
                        ? (await getModuleCommit(module)) === pin.commit
                        : currentBranch === cloneRef
                    if (!alreadyThere) {
                        console.log(`Module '${module}' is on '${currentBranch}', switching to '${cloneRef}'...`)
                        await cloneGit(module, true, false, cloneRef, pin.commit)
                    }
                }
                // Fresh-install detection must happen BEFORE buildAndUp starts the
                // tracker (a fresh tracker creates an empty LevelDB immediately).
                let utxoWasFresh = false
                if (module === XChainService.XCHAIN_UTXO_TRACKER && !onlyExecution) {
                    const { utxoTrackerVolumeHasData } = require('./BootstrapService')
                    utxoWasFresh = !(await utxoTrackerVolumeHasData(coin, network))
                }
                // Decoder/indexer freshness must also be sampled BEFORE buildAndUp;
                // once the service starts it fills its `blocks` table, which would
                // make a fresh install look populated.
                let mariaWasFresh = false
                if ((module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) && !onlyExecution) {
                    const { mariaDbModuleHasData } = require('./BootstrapService')
                    mariaWasFresh = !(await mariaDbModuleHasData(coin, network, module))
                }
                const containerId = await buildAndUp(module, coin, network, overwriteContainerId, onlyExecution, dockerCmdArgs)
                if (module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_INDEXER) {
                    await setDatabaseParameters()
                } else if (module === HUB_MODULE_NAME) {
                    // Rotate the hub DB account to match the (possibly just-changed) HUB_DB_PASS
                    // env the new container started with; without this an `update xchain-hub`
                    // leaves the live hub account on the old password and locks the hub out.
                    await setHubDatabaseParameters()
                }
                if (utxoWasFresh) {
                    const { ensureBootstrapUtxoTracker } = require('./BootstrapService')
                    await ensureBootstrapUtxoTracker(coin, network)
                }
                if (mariaWasFresh) {
                    const { ensureBootstrapMariaDb } = require('./BootstrapService')
                    await ensureBootstrapMariaDb(coin, network, module)
                }
                if (!onlyExecution) await statusChanged()
                return containerId
            } catch (err) {
                throw err
            }
        } else {
            return false
        }
    }
}

async function uninstallModule(coin, network, module) {
    const { DB_MODULE_NAME } = require('../config/constants')
    const modulesStatus = await getStatus(null, null, false)

    if (module === DB_MODULE_NAME) {
        throw "The database must be manually removed"
    }

    const moduleStatus = modulesStatus?.[(coin ?? "")]?.[(network ?? "")]?.[module]
    if (moduleStatus !== undefined) {
        console.log("Uninstalling " + module + " (" + coin + "/" + network + ")")
        try {
            if (moduleStatus["status"]["State"]["Status"] !== "exited") {
                await killContainer(moduleStatus["container_id"])
            }
            await removeContainer(moduleStatus["container_id"])
            await statusChanged()
            const removed = await db.removeModuleContainer(module, coin, network)
            if (removed) {
                return removed
            } else {
                throw "There was a problem trying to remove a container from the database"
            }
        } catch (err) {
            // Preserve the original error instead of masking every failure in
            // this multi-step block (kill/remove/statusChanged/registry delete)
            // as a fixed "kill" message. Notably a successful `docker rm` with a
            // failed registry-row delete leaves the container gone but the
            // `modules` row stale, and the misleading message points diagnosis
            // at the wrong step.
            throw err
        }
    } else {
        // No live container found for this module (already removed, or never
        // built). A stale row can still linger in the `modules` tracking table
        // For example, the container may have been `docker rm`'d out of band, which silently
        // makes a later install/update misbehave. getStatus probes every tracked
        // container and drops the ones that are gone, so reaching here means the
        // container truly isn't present: clean up any orphaned row.
        const staleId = await db.getModuleContainer(module, coin, network)
        if (staleId) {
            await db.removeModuleContainer(module, coin, network)
            await statusChanged()
            console.log("Removed stale tracking row for " + module + " (" + coin + "/" + network + ")")
        }
        return true
    }
}

module.exports = {
    SERVICE_HEALTHCHECK,
    cloneGit,
    readCheckoutIdentityFromDisk,
    getModuleBranch,
    getModuleCommit,
    resolveBundledLibRef,
    buildAndUp,
    buildHealthcheckArgs,
    buildModuleDockerArgs,
    assertNoHostPortConflicts,
    installModule,
    uninstallModule
}
