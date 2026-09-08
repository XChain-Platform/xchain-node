'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The install-target record is what turns `xchain-node update all` into "take
// me to the newest release" on a release node and "newest commits" on a branch
// node. Without it a no-ref update read each module's git branch, which on a
// pinned (detached) checkout is `HEAD`, and every operator node failed its own
// documented upgrade command.

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function load(dataDir, moduleDir, getModuleBranch) {
    return proxyquire('../../src/services/InstallTargetService', {
        '../config/constants': { dataDir, moduleDir },
        './ModuleService': { getModuleBranch }
    })
}

describe('InstallTargetService', function () {
    let workDir, dataDir, moduleDir

    beforeEach(function () {
        workDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-target-'))
        dataDir   = path.join(workDir, 'data')
        moduleDir = path.join(workDir, 'modules')
    })

    afterEach(function () {
        fs.rmSync(workDir, { recursive: true, force: true })
        sinon.restore()
    })

    describe('recordInstallTarget() / readInstallTarget()', function () {

        it('round-trips a release target and creates the data dir on the way', function () {
            const svc = load(dataDir, moduleDir, sinon.stub())
            expect(svc.recordInstallTarget({ kind: 'release', ref: 'v0.15.2', tag: 'v0.15.2' })).to.equal(true)
            expect(svc.readInstallTarget()).to.deep.equal({ kind: 'release', ref: 'v0.15.2', tag: 'v0.15.2' })
        })

        it('round-trips a branch target with no tag', function () {
            const svc = load(dataDir, moduleDir, sinon.stub())
            svc.recordInstallTarget({ kind: 'branch', ref: 'develop' })
            expect(svc.readInstallTarget()).to.deep.equal({ kind: 'branch', ref: 'develop', tag: null })
        })

        it('answers null when there is no record', function () {
            const svc = load(dataDir, moduleDir, sinon.stub())
            expect(svc.readInstallTarget()).to.equal(null)
        })

        it('answers null for an unreadable or malformed record rather than throwing', function () {
            const svc = load(dataDir, moduleDir, sinon.stub())
            fs.mkdirSync(dataDir, { recursive: true })
            fs.writeFileSync(svc.targetFilePath(), '{not json')
            expect(svc.readInstallTarget()).to.equal(null)
            fs.writeFileSync(svc.targetFilePath(), JSON.stringify({ kind: 'tarball', ref: 'x' }))
            expect(svc.readInstallTarget()).to.equal(null)
        })

        it('refuses to record a target it could not act on', function () {
            const svc = load(dataDir, moduleDir, sinon.stub())
            expect(svc.recordInstallTarget(null)).to.equal(false)
            expect(svc.recordInstallTarget({ kind: 'release' })).to.equal(false)
            expect(svc.recordInstallTarget({ kind: 'other', ref: 'x' })).to.equal(false)
            expect(fs.existsSync(svc.targetFilePath())).to.equal(false)
        })

        it('does not throw when the data dir cannot be written', function () {
            const svc = load(path.join(workDir, 'a-file', 'data'), moduleDir, sinon.stub())
            fs.writeFileSync(path.join(workDir, 'a-file'), 'blocks the directory')
            const warn = sinon.stub(console, 'warn')
            expect(svc.recordInstallTarget({ kind: 'release', ref: 'v0.15.2' })).to.equal(false)
            expect(warn.calledOnce).to.equal(true)
        })
    })

    describe('inferInstallTarget()', function () {

        function withModules(names) {
            fs.mkdirSync(moduleDir, { recursive: true })
            for (const name of names) fs.mkdirSync(path.join(moduleDir, name))
        }

        it('classifies detached checkouts as a release node', async function () {
            withModules(['xchain-hub', 'xchain-indexer'])
            const svc = load(dataDir, moduleDir, sinon.stub().resolves('HEAD'))
            const t = await svc.inferInstallTarget()
            expect(t).to.deep.equal({ kind: 'release', ref: null, tag: null, inferred: true })
        })

        it('classifies any module on a named branch as a branch node on that branch', async function () {
            // A developer who installed `develop` must never have a no-ref update
            // silently move them onto a release.
            withModules(['xchain-hub', 'xchain-indexer'])
            const branches = { 'xchain-hub': 'HEAD', 'xchain-indexer': 'develop' }
            const svc = load(dataDir, moduleDir, sinon.stub().callsFake(async m => branches[m]))
            const t = await svc.inferInstallTarget()
            expect(t).to.deep.equal({ kind: 'branch', ref: 'develop', tag: null, inferred: true })
        })

        it('classifies a node with no checkouts as a release node', async function () {
            const svc = load(dataDir, moduleDir, sinon.stub())
            const t = await svc.inferInstallTarget()
            expect(t.kind).to.equal('release')
        })

        it('skips a directory that is not a git checkout', async function () {
            withModules(['notes', 'xchain-hub'])
            const branches = { 'xchain-hub': 'HEAD' }
            const svc = load(dataDir, moduleDir, sinon.stub().callsFake(async m => {
                if (!(m in branches)) throw new Error('not a git repository')
                return branches[m]
            }))
            const t = await svc.inferInstallTarget()
            expect(t.kind).to.equal('release')
        })
    })

    describe('resolveUpdateTarget()', function () {

        it('prefers the record over the checkouts', async function () {
            fs.mkdirSync(moduleDir, { recursive: true })
            fs.mkdirSync(path.join(moduleDir, 'xchain-hub'))
            const svc = load(dataDir, moduleDir, sinon.stub().resolves('develop'))
            svc.recordInstallTarget({ kind: 'release', ref: 'v0.15.2' })
            const t = await svc.resolveUpdateTarget()
            expect(t.kind).to.equal('release')
            expect(t.inferred).to.equal(false)
        })

        it('falls back to the checkouts when there is no record', async function () {
            fs.mkdirSync(moduleDir, { recursive: true })
            fs.mkdirSync(path.join(moduleDir, 'xchain-hub'))
            const svc = load(dataDir, moduleDir, sinon.stub().resolves('develop'))
            const t = await svc.resolveUpdateTarget()
            expect(t).to.deep.equal({ kind: 'branch', ref: 'develop', tag: null, inferred: true })
        })
    })
})
