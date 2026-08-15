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
 * XChain Node - Release Manifest Service
 *
 * Resolves what an install actually checks out. Two shapes exist:
 *
 *   release  `install v0.9.0` / `install` (no ref)  -> every module and every
 *            bundled library is pinned to the exact commit the manifest records
 *            for that train. Reproducible, and verified after clone.
 *   branch   `install develop` / `install master`   -> tracking install, no
 *            pins; this is the developer path and is labelled unreleased.
 *
 * The manifest itself is written into xchain-node at ceremony step 6; see
 * src/release-manifest.json for its shape and why it is empty until the first
 * train is cut.
 ********************************************************************/

const fs    = require('fs')
const path  = require('path')
const axios = require('axios')

const { githubApiHeaders, githubRateLimitError } = require('../GitHubDownloader')
const { verifyManifestForTag } = require('./ReleaseSignatureService')

// The repo that carries the manifest. Pinned installs resolve their manifest
// from a tag on THIS repo, never from a sibling.
const MANIFEST_OWNER = 'XChain-Platform'
const MANIFEST_REPO  = 'xchain-node'
const MANIFEST_FILE  = 'release-manifest.json'

const localManifestPath = path.join(__dirname, '..', MANIFEST_FILE)

// A release ref is `vMAJOR.MINOR.PATCH`, optionally with a pre-release or build
// suffix. The leading `v` is REQUIRED and is what makes classification
// unambiguous: it is what distinguishes the release ref `v2.7.17` from a branch
// legitimately named `2.7.17` (the legacy per-component version numbers this
// platform used before the adoption jump were exactly that shape).
const RELEASE_REF = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function isReleaseRef(ref) {
    return typeof ref === 'string' && RELEASE_REF.test(ref.trim())
}

// A 40-hex commit id. Anything else in a `commit` field is a malformed manifest,
// and a malformed pin must fail the install rather than silently degrade to
// "clone whatever the tag points at today" (a tag is mutable by the repo owner;
// the commit id is what actually pins).
const COMMIT_SHA = /^[0-9a-f]{40}$/

function readLocalManifest() {
    try {
        return JSON.parse(fs.readFileSync(localManifestPath, 'utf8'))
    } catch {
        return null
    }
}

// True once a real train has been cut. Pre-adoption the shipped manifest carries
// an empty `components`, and every caller must treat that as "no pins exist"
// rather than "this release pins nothing", or a first install would resolve
// every module to a null ref.
function manifestHasPins(manifest) {
    return !!(manifest && manifest.components && Object.keys(manifest.components).length > 0)
}

// Resolve one component's pin. Returns null when the manifest does not carry
// the component at all (a tier-2 app, or a pre-adoption empty manifest); throws
// when it carries it in a shape that cannot pin.
function getComponentPin(manifest, component) {
    if (!manifestHasPins(manifest)) return null

    const pin = manifest.components[component]
    if (!pin) return null

    if (!pin.commit || !COMMIT_SHA.test(String(pin.commit))) {
        throw new Error(
            `Release manifest entry for '${component}' has no usable commit id`
            + ` (found ${JSON.stringify(pin.commit)}). A tag alone does not pin:`
            + ` tags are mutable by the repo owner, so the manifest records the`
            + ` tag's merge-commit SHA and the install verifies against it.`
        )
    }

    return { tag: pin.tag || null, commit: String(pin.commit) }
}

async function fetchManifestAtTag(tag) {
    // The manifest is fetched from the tag itself rather than from the running
    // checkout: `install v0.9.0` is routinely driven by a node already running
    // some other version, and that node's own manifest describes ITS train.
    // The one path that does not run the signature gate below, deliberately: this
    // file came out of the running checkout, whose own provenance was decided
    // when the operator installed it (signed tag, verified clone). Re-verifying
    // it here would prove only that the checkout agrees with itself.
    const local = readLocalManifest()
    if (local && local.platform_version && `v${local.platform_version}` === tag) {
        return local
    }

    const url = `https://api.github.com/repos/${MANIFEST_OWNER}/${MANIFEST_REPO}/contents/src/${MANIFEST_FILE}`
    let result
    try {
        result = await axios.get(url, { headers: githubApiHeaders(), params: { ref: tag } })
    } catch (error) {
        const rateLimited = githubRateLimitError(error)
        if (rateLimited) throw rateLimited
        if (error && error.response && error.response.status === 404) {
            throw new Error(
                `No release manifest found for ${tag}. Either ${tag} is not a published`
                + ` xchain-node release, or it predates the release-manifest rails.`
            )
        }
        throw error
    }

    const body = result.data
    if (!body || !body.content) {
        throw new Error(`Release manifest for ${tag} came back empty`)
    }

    const bytes = Buffer.from(body.content, body.encoding || 'base64')

    // PROVENANCE GATE (spec section 12). Everything downstream of here treats
    // the manifest as authoritative - it decides which commit every component
    // is cloned at - and up to this line it is just a file the same server
    // served. Verify the release key covered these exact bytes BEFORE parsing
    // them, so a tampered manifest is refused rather than acted on.
    await verifyManifestBytes(tag, bytes)

    try {
        return JSON.parse(bytes.toString('utf8'))
    } catch (err) {
        throw new Error(`Release manifest for ${tag} is not valid JSON: ${err.message}`)
    }
}

/**
 * Fetch one published asset from a release, or null when the release does not
 * carry it (which the caller reads as "this release publishes no signature").
 */
async function fetchReleaseAsset(tag, assetName) {
    const url = `https://api.github.com/repos/${MANIFEST_OWNER}/${MANIFEST_REPO}/releases/tags/${tag}`
    let release
    try {
        release = await axios.get(url, { headers: githubApiHeaders() })
    } catch (error) {
        const rateLimited = githubRateLimitError(error)
        if (rateLimited) throw rateLimited
        if (error && error.response && error.response.status === 404) return null
        throw error
    }

    const assets = (release.data && release.data.assets) || []
    const asset  = assets.find(entry => entry && entry.name === assetName)
    if (!asset || !asset.url) return null

    // The asset endpoint answers a 302 to signed object storage, and that
    // storage REJECTS a request still carrying our Authorization header (the
    // same trap githubApiHeaders documents for coin-node downloads). So follow
    // the redirect by hand and drop the credentials on the second hop.
    const first = await axios.get(asset.url, {
        headers: { ...githubApiHeaders(), Accept: 'application/octet-stream' },
        responseType: 'arraybuffer',
        maxRedirects: 0,
        validateStatus: status => (status >= 200 && status < 300) || [301, 302, 307, 308].includes(status)
    })

    if (first.status >= 300) {
        const location = first.headers && first.headers.location
        if (!location) throw new Error(`Release asset ${assetName} redirected without a location header`)
        const followed = await axios.get(location, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'GitHubDownloader' }
        })
        return Buffer.from(followed.data)
    }

    return Buffer.from(first.data)
}

async function verifyManifestBytes(tag, bytes) {
    return verifyManifestForTag({
        tag,
        manifestBytes: bytes,
        fetchAsset: assetName => fetchReleaseAsset(tag, assetName)
    })
}

// The ONE latest-release semantic for the platform (spec section 5).
//
// Two paths existed and disagreed: VersionService hits `releases/latest`, which
// the GitHub API defines as the newest NON-prerelease, non-draft release;
// GitHubDownloader fetches the full list and sorts by published_at, which does
// not exclude either. They are reconciled by ruling that train releases are
// never flagged as GitHub pre-releases (D1/section 5), which makes
// `releases/latest` well-defined, and by routing platform-version resolution
// through this function only. GitHubDownloader keeps its own sort because it
// resolves COIN daemon releases from third-party repos whose flagging this
// project does not control.
async function resolveLatestReleaseTag() {
    const url = `https://api.github.com/repos/${MANIFEST_OWNER}/${MANIFEST_REPO}/releases/latest`
    let result
    try {
        result = await axios.get(url, { headers: githubApiHeaders() })
    } catch (error) {
        const rateLimited = githubRateLimitError(error)
        if (rateLimited) throw rateLimited
        if (error && error.response && error.response.status === 404) {
            // No published release yet. Pre-first-train this is the NORMAL state,
            // so it is reported as "none" and the caller falls back to a branch
            // install rather than failing.
            return null
        }
        throw error
    }

    return result.data && result.data.tag_name ? result.data.tag_name : null
}

/**
 * Classify the operator's ref argument and, for a release, load its manifest.
 *
 * @param {string|null} ref            the single ref slot from the CLI (a branch
 *                                     name, a vX.Y.Z release, or null for default)
 * @param {object}      [opts]
 * @param {string}      [opts.defaultBranch]  branch to fall back to when no
 *                                            release can be resolved
 * @returns {Promise<{kind:'release'|'branch', ref:string, tag:string|null,
 *                    manifest:object|null, resolvedFrom:string}>}
 */
async function resolveInstallTarget(ref, { defaultBranch = 'master' } = {}) {
    if (isReleaseRef(ref)) {
        const tag = ref.trim()
        return {
            kind: 'release',
            ref: tag,
            tag,
            manifest: await fetchManifestAtTag(tag),
            resolvedFrom: 'operator-supplied release ref'
        }
    }

    if (ref) {
        return { kind: 'branch', ref, tag: null, manifest: null, resolvedFrom: 'operator-supplied branch' }
    }

    // No ref: the default install is the latest release, still fully pinned.
    let tag = null
    try {
        tag = await resolveLatestReleaseTag()
    } catch (err) {
        console.warn(`Could not resolve the latest xchain-node release (${err.message}).`)
        console.warn(`Falling back to a tracking install of '${defaultBranch}' (UNRELEASED).`)
        return { kind: 'branch', ref: defaultBranch, tag: null, manifest: null, resolvedFrom: 'fallback after lookup failure' }
    }

    if (!tag) {
        // Pre-first-train, and after any release-less bootstrap. Not an error.
        console.log(`No published xchain-node release yet; installing '${defaultBranch}' (UNRELEASED).`)
        return { kind: 'branch', ref: defaultBranch, tag: null, manifest: null, resolvedFrom: 'no published release' }
    }

    return {
        kind: 'release',
        ref: tag,
        tag,
        manifest: await fetchManifestAtTag(tag),
        resolvedFrom: 'latest published release'
    }
}

// The install currently in flight. buildAndUp stages bundled libraries deep
// inside a per-module code path that no ref is threaded through, so the active
// target is published here for the duration of a run rather than added to the
// signature of every intermediate caller. Set once at the top of an
// install/update run and cleared when it ends.
let activeTarget = null

function setActiveTarget(target) { activeTarget = target || null }
function getActiveTarget()       { return activeTarget }
function clearActiveTarget()     { activeTarget = null }

/**
 * Resolve the ref a component should be cloned at for the active install.
 *
 * @param {string}      component
 * @param {string|null} fallbackRef  ref to use when no release is active
 * @returns {{ref:string|null, commit:string|null, pinned:boolean}}
 */
function resolveComponentRef(component, fallbackRef = null) {
    const target = getActiveTarget()

    if (target && target.kind === 'release') {
        const pin = getComponentPin(target.manifest, component)
        if (pin) {
            // Check out the TAG and verify the commit. Cloning the tag keeps the
            // clone a single shallow-able operation; the commit check is what
            // actually pins, because a tag can be moved after publication.
            return { ref: pin.tag || pin.commit, commit: pin.commit, pinned: true }
        }
    }

    return { ref: fallbackRef, commit: null, pinned: false }
}

module.exports = {
    isReleaseRef,
    readLocalManifest,
    manifestHasPins,
    getComponentPin,
    fetchManifestAtTag,
    fetchReleaseAsset,
    resolveLatestReleaseTag,
    resolveInstallTarget,
    resolveComponentRef,
    setActiveTarget,
    getActiveTarget,
    clearActiveTarget,
    MANIFEST_OWNER,
    MANIFEST_REPO,
    MANIFEST_FILE
}
