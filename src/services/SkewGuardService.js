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
 * XChain Node - Skew Guard Service
 *
 * Version-skew / deploy-ordering guard for `update`. The hub is
 * the platform's config oracle: downstream services (indexer first) must
 * never be updated past the hub they talk to. DEPLOY-ORDER.md documents
 * hub-before-indexer as prose; this makes it a code-level refusal.
 *
 * Source of truth for the constraint: a per-module manifest field
 * `xchainRequiresHub` in the downstream module's OWN package.json (a
 * minimum hub semver, e.g. "2.2.0"), read from the exact source tree
 * about to be deployed. Chosen over shared constants (would need an
 * xchain-node release to track every module bump) and over DEPLOY-ORDER
 * ordering (only orders a single `update all`; cannot refuse a lone
 * out-of-order `update xchain-indexer`). A module with no field declares
 * no constraint and updates as before.
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, XChainService } = require('../config/constants')
const { db }                                        = require('../state')
const { getModuleTmpDir }                           = require('./ConfigService')
const { getContainerModuleVersion }                 = require('./VersionService')

// Only these modules can carry a hub-version constraint; everything else
// skips the guard entirely (no extra tmp clone on their update path).
const HUB_DEPENDENT_MODULES = [
    XChainService.XCHAIN_INDEXER,
    EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME
]

const SKIP_ENV = 'XCHAIN_NODE_SKIP_SKEW_GUARD'

function skewGuardSkipped() {
    const v = process.env[SKIP_ENV]
    return v === '1' || v === 'true' || v === 'yes'
}

// Numeric dotted-version compare (semver-shaped: 1.2.10 > 1.2.9).
// Returns -1 / 0 / 1; non-numeric segments compare as 0 so a stray
// suffix never makes a newer hub look older.
function compareVersions(a, b) {
    const pa = String(a).trim().replace(/^v/, '').split('.')
    const pb = String(b).trim().replace(/^v/, '').split('.')
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
        const na = parseInt(pa[i], 10) || 0
        const nb = parseInt(pb[i], 10) || 0
        if (na < nb) return -1
        if (na > nb) return 1
    }
    return 0
}

// Extracts the required minimum hub version from a parsed package.json.
// Returns null when the module declares no constraint.
function getRequiredHubVersion(pkg) {
    if (!pkg || typeof pkg !== 'object') return null
    const raw = pkg['xchainRequiresHub']
    if (raw === undefined || raw === null || raw === '') return null
    if (typeof raw !== 'string' || !/^v?\d+(\.\d+)*$/.test(raw.trim())) {
        throw new Error('xchainRequiresHub must be a plain minimum version like "2.2.0", got: ' + JSON.stringify(raw))
    }
    return raw.trim().replace(/^v/, '')
}

/**
 * Refuses (throws) when `module`'s to-be-deployed source declares a
 * minimum hub version and the installed hub container is behind it.
 *
 * Fail-closed rules:
 *  - constraint declared + hub installed + hub older     -> refuse
 *  - constraint declared + hub installed + unreadable ver-> refuse
 *  - constraint declared + NO hub installed              -> proceed with a
 *    warning (hubless stacks - regtest, NO_HUB explorer - are legitimate)
 *  - no constraint declared / module not hub-dependent   -> proceed
 *
 * `deps` is injectable for tests; production callers pass nothing.
 */
async function assertHubNotBehind(module, branch = null, deps = {}) {
    if (!HUB_DEPENDENT_MODULES.includes(module)) return { checked: false, reason: 'not-hub-dependent' }
    if (skewGuardSkipped()) {
        console.warn(`WARNING: ${SKIP_ENV} is set; skipping the hub version-skew guard for ${module}. ` +
            'An out-of-order deploy can halt the stack (hub must update before its downstream services).')
        return { checked: false, reason: 'skipped-by-env' }
    }

    const cloneGitDep         = deps.cloneGit || require('./ModuleService').cloneGit
    const readPkg             = deps.readPackageJson || defaultReadPackageJson
    const getHubContainer     = deps.getHubContainer || (() => db.getModuleContainer(HUB_MODULE_NAME, '', ''))
    const getHubVersion       = deps.getHubVersion || ((cid) => getContainerModuleVersion(HUB_MODULE_NAME, '', '', cid))

    // Clone the module's target source into tmp and read ITS manifest: the
    // constraint must come from the code that is about to run, not from
    // whatever is currently installed.
    let pkg
    try {
        await cloneGitDep(module, false, true, branch)
        pkg = readPkg(module)
    } catch (err) {
        // Can't fetch the source at all: the update itself is about to fail
        // the same way, so don't add a second failure mode here.
        console.warn(`Skew guard: could not read ${module} manifest (${err && err.message ? err.message : err}); guard not applied.`)
        return { checked: false, reason: 'manifest-unreadable' }
    }

    const requiredHub = getRequiredHubVersion(pkg)
    if (!requiredHub) return { checked: false, reason: 'no-constraint' }

    const hubContainerId = await getHubContainer()
    if (!hubContainerId) {
        console.warn(`Skew guard: ${module} requires hub >= ${requiredHub} but no hub is installed on this stack; proceeding (hubless stack).`)
        return { checked: true, requiredHub, hubVersion: null, ok: true }
    }

    let hubVersion
    try {
        hubVersion = await getHubVersion(hubContainerId)
    } catch (err) {
        throw new Error(
            `update refused: ${module} requires hub >= ${requiredHub} but the installed hub's version could not be read ` +
            `(${err && err.message ? err.message : err}). Update ${HUB_MODULE_NAME} first (see DEPLOY-ORDER.md), ` +
            `or set ${SKIP_ENV}=1 to override.`
        )
    }

    if (compareVersions(hubVersion, requiredHub) < 0) {
        throw new Error(
            `update refused: ${module} requires hub >= ${requiredHub} but the installed hub is ${hubVersion}. ` +
            `Update ${HUB_MODULE_NAME} first (see DEPLOY-ORDER.md), or set ${SKIP_ENV}=1 to override.`
        )
    }

    return { checked: true, requiredHub, hubVersion, ok: true }
}

function defaultReadPackageJson(module) {
    const pkgPath = path.join(getModuleTmpDir(module), 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
}

module.exports = {
    HUB_DEPENDENT_MODULES,
    SKIP_ENV,
    compareVersions,
    getRequiredHubVersion,
    assertHubNotBehind
}
