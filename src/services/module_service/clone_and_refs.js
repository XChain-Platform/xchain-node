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
let execFileAsync = promisify(execFile)
let fs = require('fs')
let { modulesUrls, DEFAULT_MODULE_BRANCH } = require('../../config')
let { getModuleDir, getModuleTmpDir, moduleDirExists, removeModuleTmpDir, createModuleTmpDir } = require('../config_service')
let { redactSecrets } = require('../../utils/helpers')
let releaseManifestService = require('../release_manifest_service')
let { CLONE_STAGING_SUFFIX, CLONE_PREVIOUS_SUFFIX, runGitClone, assertCheckoutCommit, verifyDeploySource, reportDeployedSource } = require('./git_checkout')
const { getLogger } = require('../../observability/logger');
let logger = getLogger();

function configureDependencies(dependencies) {
    ({
        execFileAsync, fs, modulesUrls, DEFAULT_MODULE_BRANCH, getModuleDir,
        getModuleTmpDir, moduleDirExists, removeModuleTmpDir, createModuleTmpDir,
        redactSecrets, releaseManifestService, CLONE_STAGING_SUFFIX,
        CLONE_PREVIOUS_SUFFIX, runGitClone, assertCheckoutCommit,
        verifyDeploySource, reportDeployedSource, logger
    } = dependencies)
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
function validateCloneRequest(module, branch) {
    if (!(module in modulesUrls)) {
        throw "module doesn't have an url"
    }
    if (branch && !/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
        throw "Invalid branch name: " + branch + " (branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes)"
    }
}

async function cloneTemporaryCheckout(module, branch, expectedCommit) {
    // The tmp tree is scratch space (version probes, the skew guard) that is
    // rebuilt on every use and holds nothing unrecoverable, so it keeps the
    // cheap wipe-then-clone shape.
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

async function cloneNewCheckout(module, branch, expectedCommit, destination) {
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

async function stageReplacement(module, branch, expectedCommit, destination) {
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
    return { staging, previous }
}

function swapReplacement(module, destination, staging, previous) {
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
}

async function cloneGit(module, rewrite = false, useTmp = false, branch = null, expectedCommit = null) {
    validateCloneRequest(module, branch)
    if (useTmp) return cloneTemporaryCheckout(module, branch, expectedCommit)

    const destination = getModuleDir(module)
    if (!moduleDirExists(module)) return cloneNewCheckout(module, branch, expectedCommit, destination)
    if (!rewrite) throw "Module directory already exists"

    const { staging, previous } = await stageReplacement(module, branch, expectedCommit, destination)
    swapReplacement(module, destination, staging, previous)
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
    const { resolveComponentRef } = releaseManifestService

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

    logger.warn(`Bundled library ${lib}: ${module} is on a detached HEAD and no release`
        + ` manifest is active, so the library cannot inherit a ref.`
        + ` Falling back to '${DEFAULT_MODULE_BRANCH}'.`)
    return { ref: DEFAULT_MODULE_BRANCH, commit: null, pinned: false, reason: 'default branch fallback' }
}

module.exports = { configureDependencies, cloneGit, getModuleBranch, getModuleCommit, resolveBundledLibRef }
