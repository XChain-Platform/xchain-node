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
 * XChain Node - Install Target Service
 *
 * Remembers what kind of thing this node is on: a RELEASE (manifest-pinned,
 * the operator path) or a BRANCH (tracking, the developer path). `update`
 * with no ref reads this to decide what "newer" means: the latest published
 * release for a release node, the branch tip for a branch node.
 *
 * Before this record existed a no-ref update re-read each module's git
 * branch, and a pinned checkout is detached, so every release-installed node
 * failed its own documented upgrade command with "branch 'HEAD' not found"
 * (measured on the v0.15.2 fleet roll, 2026-09-07).
 *
 * A node installed by an older CLI has no record; it is classified from its
 * module checkouts (see inferInstallTarget) and the record is written on the
 * next install/update run.
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { dataDir, moduleDir } = require('../config/constants')

const TARGET_FILE = 'install-target.json'

function targetFilePath() {
    return path.join(dataDir, TARGET_FILE)
}

/**
 * Persist the target a run is converging the node on. Written at the START of
 * the run, not the end: a run that fails halfway leaves some modules moved,
 * and the next `update all` must converge on the same target rather than
 * inherit whatever the surviving checkouts happen to say.
 *
 * @param {{kind:'release'|'branch', ref:string, tag?:string|null}} target
 */
function recordInstallTarget(target) {
    if (!target || (target.kind !== 'release' && target.kind !== 'branch') || !target.ref) return false
    const record = {
        kind: target.kind,
        ref: target.ref,
        tag: target.kind === 'release' ? (target.tag || target.ref) : null,
        recordedAt: new Date().toISOString(),
        recordedBy: require('../../package.json').version
    }
    try {
        fs.mkdirSync(dataDir, { recursive: true })
        // Write-then-rename so a crash mid-write leaves the previous record,
        // never a half-written one that parses as "no record".
        const tmp = targetFilePath() + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n')
        fs.renameSync(tmp, targetFilePath())
        return true
    } catch (err) {
        console.warn(`Could not record the install target (${err.message}); the next no-ref update will classify the node from its checkouts.`)
        return false
    }
}

/**
 * @returns {{kind:'release'|'branch', ref:string, tag:string|null}|null}
 */
function readInstallTarget() {
    try {
        const record = JSON.parse(fs.readFileSync(targetFilePath(), 'utf8'))
        if (record && (record.kind === 'release' || record.kind === 'branch') && record.ref) {
            return { kind: record.kind, ref: record.ref, tag: record.tag || null }
        }
    } catch { /* no record, or unreadable: same thing */ }
    return null
}

/**
 * Classify a node that has no record from its module checkouts.
 *
 * A pinned install is a detached checkout (`rev-parse --abbrev-ref HEAD`
 * answers `HEAD`); a tracking install sits on a named branch. Any module on
 * a named branch makes the node a branch node on that branch: a developer
 * who installed `develop` must not have a no-ref update silently move them
 * onto a release. No checkouts at all answers release, which is the only
 * shape a fresh operator install can have.
 *
 * @param {object} [deps]  test seams
 * @returns {Promise<{kind:'release'|'branch', ref:string|null, tag:null, inferred:true}>}
 */
async function inferInstallTarget(deps = {}) {
    const listModules    = deps.listModules || defaultListModules
    const getModuleBranch = deps.getModuleBranch || require('./ModuleService').getModuleBranch

    for (const module of listModules()) {
        let branch = null
        try { branch = await getModuleBranch(module) } catch { continue }
        if (branch && branch !== 'HEAD') {
            return { kind: 'branch', ref: branch, tag: null, inferred: true }
        }
    }
    return { kind: 'release', ref: null, tag: null, inferred: true }
}

function defaultListModules() {
    try {
        return fs.readdirSync(moduleDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
    } catch {
        return []
    }
}

/**
 * The target a no-ref `update` should converge on: the record when there is
 * one, otherwise the classification of the checkouts.
 */
async function resolveUpdateTarget(deps = {}) {
    const recorded = readInstallTarget()
    if (recorded) return { ...recorded, inferred: false }
    return inferInstallTarget(deps)
}

module.exports = {
    TARGET_FILE,
    targetFilePath,
    recordInstallTarget,
    readInstallTarget,
    inferInstallTarget,
    resolveUpdateTarget
}
