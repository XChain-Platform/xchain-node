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

let { execFile } = require('child_process')
const assert = require('node:assert/strict')
const os = require('node:os')
const test = require('node:test')
const { promisify } = require('util')
let execFileAsync = promisify(execFile)
let fs = require('fs')
let path = require('path')
let { modulesUrls } = require('../../config')
let { redactSecrets } = require('../../utils/helpers')
const { getLogger } = require('../../observability/logger');
let logger = getLogger();

function configureDependencies(dependencies) {
    ({ execFile, execFileAsync, fs, path, modulesUrls, redactSecrets, logger } = dependencies)
}

// Sibling directories make a rewrite-clone atomic-ish (see cloneGit).
// Both live beside the module checkout inside the modules dir, so the two
// renames below stay on one filesystem and cannot fail with EXDEV.
const CLONE_STAGING_SUFFIX  = '.xchain-node-staging'
const CLONE_PREVIOUS_SUFFIX = '.xchain-node-previous'

async function localSourceIsDetached(url) {
    if (!isLocalPathSource(url)) return false
    try {
        const { stdout } = await execFileAsync('git', ['-C', url, 'rev-parse', '--abbrev-ref', 'HEAD'])
        return String(stdout || '').trim() === 'HEAD'
    } catch {
        return false
    }
}

// Run `git clone` into `destination`. Rejects with the operator-facing string
// the callers already surface; performs no filesystem cleanup of its own so
// the caller owns the rollback decision.
async function runGitClone(module, branch, destination) {
    const gitUrl = modulesUrls[module]
    const cloneBranch = branch && await localSourceIsDetached(gitUrl) ? null : branch

    return new Promise((resolve, reject) => {
        const cloneArgs = ['clone']
        if (cloneBranch) cloneArgs.push('-b', cloneBranch)
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
                    // scrolling console.warn is a silent-wrong-code hazard.
                    // Fail the clone instead.
                    //
                    // The hint matters because the mechanism is routinely misread
                    // (, and the  note it corrects): install/update clone
                    // from the module's REMOTE, so a branch that exists only in the
                    // checkout on this box is invisible here. Push it, or point the
                    // module at a local path with XCHAIN_NODE_MODULES_URLS_OVERRIDE.
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

// Clone-integrity check for a pinned install.
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
        logger.warn(`WARNING: '${module}' is being deployed from the local checkout ${url},`
            + ` whose '${branch}' is ${behind} commit(s) BEHIND its own origin/${branch}`
            + ` (${local.slice(0, 12)} vs ${upstream.slice(0, 12)}).`
            + ` The deploy will contain the older tree; fetch that checkout if you meant the upstream branch.`)
    } catch { /* best-effort diagnosis; never blocks a deploy */ }
}

// Prove a freshly cloned checkout is the code the operator asked for.
//
// assertCheckoutCommit answers "is this the reviewed commit" for a manifest pin.
// No existing check answers the question a NAMED BRANCH raises: is
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
    if (await localSourceIsDetached(url)) return
    await warnIfSourceBranchIsBehind(module, url, branch)

    const tip = await readSourceBranchTip(url, branch)
    if (!tip) return

    let head = (await readCheckoutIdentity(dir)).commit
    if (!head || head === tip) return

    logger.warn(`WARNING: the clone of '${module}' landed on ${head.slice(0, 12)} but`
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
        logger.info(`Deploy source for '${module}': commit UNKNOWN (not a git checkout?) from ${url}`)
        return
    }
    logger.info(`Deploy source for '${module}': ${commit} (${branch || 'default branch'})`
        + ` committed ${committedAt || 'at an unknown time'}`
        + (subject ? ` "${subject}"` : '')
        + ` from ${url}`)
}

module.exports = {
    configureDependencies,
    CLONE_STAGING_SUFFIX,
    CLONE_PREVIOUS_SUFFIX,
    runGitClone,
    assertCheckoutCommit,
    readCheckoutIdentity,
    readCheckoutIdentityFromDisk,
    readSourceBranchTip,
    isLocalPathSource,
    warnIfSourceBranchIsBehind,
    verifyDeploySource,
    reportDeployedSource
}

if (require.main === module && process.argv.includes('--unit-test')) {
    test('runGitClone deploys the exact detached HEAD of a local source', async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-detached-clone-'))
        const source = path.join(root, 'source')
        const destination = path.join(root, 'destination')
        const module = 'detached-head-unit-test'
        const git = (args) => execFileAsync('git', args)
        t.after(() => {
            delete modulesUrls[module]
            fs.rmSync(root, { recursive: true, force: true })
        })

        await git(['init', '--initial-branch=main', source])
        await git(['-C', source, 'config', 'user.email', 'unit-test@example.invalid'])
        await git(['-C', source, 'config', 'user.name', 'Unit Test'])
        fs.writeFileSync(path.join(source, 'content.txt'), 'detached commit\n')
        await git(['-C', source, 'add', 'content.txt'])
        await git(['-C', source, 'commit', '-m', 'detached commit'])
        const detachedCommit = String((await git(['-C', source, 'rev-parse', 'HEAD'])).stdout).trim()

        fs.writeFileSync(path.join(source, 'content.txt'), 'branch tip\n')
        await git(['-C', source, 'commit', '-am', 'branch tip'])
        const branchTip = String((await git(['-C', source, 'rev-parse', 'main'])).stdout).trim()
        await git(['-C', source, 'checkout', '--detach', detachedCommit])
        modulesUrls[module] = source

        await runGitClone(module, 'main', destination)
        await verifyDeploySource(module, 'main', destination)

        const deployedCommit = String((await git(['-C', destination, 'rev-parse', 'HEAD'])).stdout).trim()
        assert.notStrictEqual(detachedCommit, branchTip)
        assert.strictEqual(deployedCommit, detachedCommit)
    })
}
