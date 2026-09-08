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
 * XChain Node - Self Update Service
 *
 * The CLI is the release carrier: its version IS the platform version, and
 * the manifest that pins every service ships inside it. So `update` moves
 * the carrier FIRST, to the release it is about to install, and then hands
 * the command to the code at that release. Until this existed the carrier
 * never moved, which left every operator on the tag they first cloned.
 *
 * Sequence, each step refusing rather than guessing:
 *   1. skip when told to (XCHAIN_NODE_NO_SELF_UPDATE), when this process IS
 *      the re-executed child (XCHAIN_NODE_UPDATE_TARGET), when the carrier
 *      is not a git checkout, or when it already runs the target version;
 *   2. refuse a dirty tracked tree (an operator's local edits are theirs to
 *      keep; a forced checkout would eat them);
 *   3. fetch tags, verify the target tag against the pinned release key;
 *   4. `git checkout --detach <tag>`, `npm install`; on a failed install put
 *      the previous commit back;
 *   5. re-execute the same command once, with the release named explicitly,
 *      under an env marker so the child never loops back here.
 *
 * The child gets the EXPLICIT form (`update <service> <chain> <network>
 * vX.Y.Z`) rather than what the operator typed: every CLI since the release
 * rails understands that shape, so a carrier moving onto a release whose CLI
 * predates the no-ref semantics still completes the update.
 *
 * Also home to the newer-release notice every command prints, because it
 * shares the version comparison and the "what to run" line.
 ********************************************************************/

const fs   = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const { dataDir } = require('../config/constants')

const CARRIER_ROOT      = path.join(__dirname, '..', '..')
const TARGET_ENV        = 'XCHAIN_NODE_UPDATE_TARGET'
const NO_SELF_UPDATE_ENV = 'XCHAIN_NODE_NO_SELF_UPDATE'
const CHECK_CACHE_FILE  = 'release-check.json'
const CHECK_TTL_MS      = 60 * 60 * 1000
const CHECK_TIMEOUT_MS  = 5000

function currentVersion() {
    return require('../../package.json').version
}

function versionOfTag(tag) {
    return String(tag || '').trim().replace(/^v/, '')
}

function selfUpdateDisabled(env = process.env) {
    return /^(1|true|yes)$/i.test(env[NO_SELF_UPDATE_ENV] || '')
}

// Semver-ish compare on the numeric triple; pre-release suffixes are not
// ordered (trains never carry them, spec section 5).
function compareVersions(a, b) {
    const pa = versionOfTag(a).split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0)
    const pb = versionOfTag(b).split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0)
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1
    }
    return 0
}

async function git(args, deps, { raw = false } = {}) {
    const run = deps.execFile || execFileAsync
    const { stdout } = await run('git', ['-C', deps.root || CARRIER_ROOT, ...args], { encoding: 'utf8' })
    return raw ? String(stdout || '') : String(stdout || '').trim()
}

/**
 * What the carrier checkout is. Every field answers "can this be moved":
 * not a repo -> leave it alone; dirty -> refuse; else the commit to fall
 * back to if the move fails.
 */
async function describeCarrier(deps = {}) {
    let isRepo = false
    try {
        isRepo = (await git(['rev-parse', '--is-inside-work-tree'], deps)) === 'true'
    } catch { /* not a git checkout */ }
    if (!isRepo) return { isRepo: false, commit: null, dirty: [] }

    const commit = await git(['rev-parse', 'HEAD'], deps)
    // Tracked files only. Untracked files (an operator's notes, a stray
    // tarball) survive a checkout and are none of this gate's business.
    // Read raw: porcelain lines start with a two-column status whose first
    // column is often a space, and a trimmed first line loses it.
    const porcelain = await git(['status', '--porcelain', '--untracked-files=no'], deps, { raw: true })
    const dirty = porcelain.split('\n').filter(line => line.length > 3).map(line => line.slice(3).trim()).filter(Boolean)
    return { isRepo: true, commit, dirty }
}

/**
 * Move the carrier checkout to `tag` and re-execute the command there.
 *
 * Returns { moved: false, reason } when nothing needed doing, so the caller
 * continues in this process. When the carrier IS moved this never returns:
 * the process exits with the child's status.
 *
 * @param {object} args
 * @param {string} args.tag          release tag to move to (vX.Y.Z)
 * @param {string[]} args.childArgs  argv (after node and the script) for the re-exec
 * @param {object} [args.deps]       test seams
 */
async function selfUpdateAndReexec({ tag, childArgs, deps = {} }) {
    const env     = deps.env || process.env
    const logger  = deps.logger || console
    const version = deps.currentVersion ? deps.currentVersion() : currentVersion()

    if (env[TARGET_ENV]) return { moved: false, reason: 'already-reexecuted' }
    if (selfUpdateDisabled(env)) {
        logger.log(`${NO_SELF_UPDATE_ENV} is set; the xchain-node CLI stays at ${version} and only the services are updated.`)
        return { moved: false, reason: 'disabled' }
    }
    if (compareVersions(version, tag) === 0) return { moved: false, reason: 'current' }

    const carrier = await (deps.describeCarrier || describeCarrier)(deps)
    if (!carrier.isRepo) {
        logger.warn(`The xchain-node CLI runs ${version} but ${tag} is the release being installed, and this CLI is not a git checkout, so it cannot move itself. Update it the way it was installed.`)
        return { moved: false, reason: 'not-a-checkout' }
    }
    if (carrier.dirty.length > 0) {
        throw new Error(
            `The xchain-node checkout at ${deps.root || CARRIER_ROOT} has local changes to tracked files`
            + ` (${carrier.dirty.join(', ')}), so the CLI cannot move itself to ${tag}. Commit, stash or`
            + ` restore them, or set ${NO_SELF_UPDATE_ENV}=1 to update the services only. Nothing was changed.`
        )
    }

    logger.log(`Updating the xchain-node CLI ${version} -> ${tag} ...`)
    // --force: a tag the release key re-signed at the same version is the
    // release key's decision, and the signature check below is what decides
    // whether a moved tag is accepted, not the fetch.
    await git(['fetch', '--tags', '--force', '--quiet', 'origin'], deps)

    const verify = deps.verifyGitTagSignature || require('./ReleaseSignatureService').verifyGitTagSignature
    const disabled = (deps.signatureCheckDisabled || require('./ReleaseSignatureService').signatureCheckDisabled)()
    try {
        const result = verify({ repoDir: deps.root || CARRIER_ROOT, tag })
        logger.log(`Tag ${tag} verified against the release key ${result.fingerprint}.`)
    } catch (err) {
        if (!disabled) throw err
        logger.warn(`WARNING: moving the CLI to ${tag} WITHOUT verifying its tag (${err.message}). XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0 is set.`)
    }

    await git(['checkout', '--detach', '--quiet', tag], deps)
    try {
        const run = deps.execFile || execFileAsync
        await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
            cwd: deps.root || CARRIER_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
        })
    } catch (err) {
        // The old code still works with its old dependencies; the new code
        // without its dependencies works for nothing. Put the old commit back.
        try { await git(['checkout', '--detach', '--quiet', carrier.commit], deps) } catch { /* reported below */ }
        throw new Error(
            `npm install failed after checking the CLI out at ${tag} (${err.message}). The checkout was`
            + ` returned to ${carrier.commit.slice(0, 12)}; run \`npm install\` there to confirm it is healthy.`
        )
    }
    logger.log(`xchain-node CLI is now ${tag}; continuing the update with it.`)

    // The caller's chance to hand back a lock the child is about to take.
    if (typeof deps.beforeSpawn === 'function') {
        try { deps.beforeSpawn() } catch { /* the child reports a held lock itself */ }
    }
    const spawnImpl = deps.spawn || spawn
    const child = spawnImpl(process.execPath, [process.argv[1], ...childArgs], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: { ...env, [TARGET_ENV]: tag }
    })
    const exitCode = await new Promise((resolve) => {
        child.on('exit', code => resolve(code == null ? 1 : code))
        child.on('error', err => {
            logger.error(`Could not re-run xchain-node at ${tag}: ${err.message}`)
            resolve(1)
        })
    })
    if (deps.exit) return deps.exit(exitCode)
    return process.exit(exitCode)
}

/**
 * Build the child's argv: the explicit pinned form of the operator's
 * command, whatever shape they typed it in.
 */
function explicitUpdateArgs(resolved, tag) {
    return ['update', resolved.service || 'all', resolved.chain || 'all', resolved.network || 'all', tag]
}

// ---------------------------------------------------------------------------
// Newer-release notice
// ---------------------------------------------------------------------------

function checkCachePath() {
    return path.join(dataDir, CHECK_CACHE_FILE)
}

function readCheckCache() {
    try {
        const record = JSON.parse(fs.readFileSync(checkCachePath(), 'utf8'))
        if (record && typeof record.checkedAt === 'number') return record
    } catch { /* no cache */ }
    return null
}

function writeCheckCache(record) {
    try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(checkCachePath(), JSON.stringify(record) + '\n')
    } catch { /* advisory */ }
}

/**
 * Resolve the latest release tag, from a one-hour cache first so the notice
 * costs the GitHub API one call an hour per node, not one per command.
 * Answers null on any failure: the notice is advisory and must never block
 * or fail a command.
 */
async function latestReleaseTagCached(deps = {}) {
    const now   = deps.now ? deps.now() : Date.now()
    const cache = (deps.readCheckCache || readCheckCache)()
    if (cache && now - cache.checkedAt < CHECK_TTL_MS) return cache.tag || null

    const resolve = deps.resolveLatestReleaseTag || require('./ReleaseManifestService').resolveLatestReleaseTag
    let tag = null
    try {
        tag = await Promise.race([
            resolve(),
            new Promise(resolveTimeout => setTimeout(() => resolveTimeout(null), deps.timeoutMs || CHECK_TIMEOUT_MS).unref?.())
        ])
    } catch {
        tag = null
    }
    // A failed lookup is cached too, so an offline node is not asked again on
    // every command for the next hour.
    ;(deps.writeCheckCache || writeCheckCache)({ checkedAt: now, tag })
    return tag
}

/**
 * Print one line when a newer release than this CLI exists. Silent when
 * current, offline, rate-limited, or already inside an update.
 *
 * @returns {Promise<string|null>} the newer tag, when there is one
 */
async function noticeNewerRelease(deps = {}) {
    const env    = deps.env || process.env
    const logger = deps.logger || console
    if (env[TARGET_ENV]) return null
    try {
        const version = deps.currentVersion ? deps.currentVersion() : currentVersion()
        const tag = await latestReleaseTagCached(deps)
        if (!tag || compareVersions(version, tag) >= 0) return null
        logger.log(`A newer XChain release is available: ${tag} (this node runs v${version}). Run: xchain-node update all`)
        return tag
    } catch {
        return null
    }
}

module.exports = {
    CARRIER_ROOT,
    TARGET_ENV,
    NO_SELF_UPDATE_ENV,
    CHECK_CACHE_FILE,
    CHECK_TTL_MS,
    currentVersion,
    versionOfTag,
    compareVersions,
    selfUpdateDisabled,
    describeCarrier,
    selfUpdateAndReexec,
    explicitUpdateArgs,
    latestReleaseTagCached,
    noticeNewerRelease
}
