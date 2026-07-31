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
//  regression: `xchain-node update <service> <chain> <network> <branch>`
// used to delete the module's deploy checkout as its first step and, when the
// clone then failed, put nothing back. On origin-host that erased
// modules/xchain-hub (and a local-only hotfix branch with it) while the running
// container stayed healthy, so nothing surfaced the loss.
//
// This suite runs the ledger's verify step for real: a real git remote, a real
// checkout on disk, a branch that exists only locally, and an assertion that
// the checkout survives. Stubs cover only the Docker/DB/state collaborators.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const { execFileSync } = require('child_process')

const realConstants = require('../../src/config/constants')

const MODULE = 'xchain-encoder'

function git(args, cwd) {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
}

// A real single-branch git repository standing in for the module's remote.
function makeRemote(dir) {
    fs.mkdirSync(dir, { recursive: true })
    git(['init', '-b', 'master'], dir)
    git(['config', 'user.email', 'test@example.com'], dir)
    git(['config', 'user.name', 'xchain-node test'], dir)
    fs.writeFileSync(path.join(dir, 'README.md'), 'remote master\n')
    git(['add', '-A'], dir)
    git(['commit', '-m', 'init'], dir)
}

// Real fs + real git; only the collaborators cloneGit never reaches are stubbed.
function loadModuleService(modulesDir, tmpDir, remote) {
    return proxyquire('../../src/services/ModuleService', {
        'fs': fs,
        '../config/constants': Object.assign({}, realConstants, {
            modulesUrls: Object.assign({}, realConstants.modulesUrls, { [MODULE]: remote })
        }),
        '../state': {
            db: { insertModuleContainer: sinon.stub().resolves(true), getModuleContainer: sinon.stub().resolves(null), removeModuleContainer: sinon.stub().resolves(true) },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir:      (mod) => path.join(modulesDir, mod),
            getModuleTmpDir:   (mod) => path.join(tmpDir, mod),
            moduleDirExists:   (mod) => fs.existsSync(path.join(modulesDir, mod)),
            checkIfModuleExists: () => true,
            removeModuleDir:   (mod) => fs.rmSync(path.join(modulesDir, mod), { recursive: true }),
            removeModuleTmpDir: (mod) => fs.rmSync(path.join(tmpDir, mod), { recursive: true, force: true }),
            createModuleTmpDir: (mod) => fs.mkdirSync(path.join(tmpDir, mod), { recursive: true }),
            getDockerContainerImageName: () => 'test-container',
            getDockerNetwork:  () => 'test-network',
            validatePort:      () => true,
            getDefaultConfig:  sinon.stub().resolves({})
        },
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), forceRemoveContainerByName: sinon.stub().resolves(), getPublishedHostPorts: sinon.stub().resolves(new Map()) },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('[regression:p0] Deploy-checkout rollback safety ', function () {
    this.timeout(30000)

    let root, modulesDir, tmpDir, remote, checkout, ms

    beforeEach(async function () {
        root       = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-xc971-'))
        modulesDir = path.join(root, 'modules')
        tmpDir     = path.join(root, 'tmp')
        remote     = path.join(root, 'remote-' + MODULE)
        checkout   = path.join(modulesDir, MODULE)
        fs.mkdirSync(modulesDir, { recursive: true })
        fs.mkdirSync(tmpDir, { recursive: true })
        makeRemote(remote)

        ms = loadModuleService(modulesDir, tmpDir, remote)
        // The deploy checkout as it exists on a provisioned box, plus a file
        // that lives ONLY there (the local-only hotfix branch's stand-in).
        await ms.cloneGit(MODULE, true, false, null)
        fs.writeFileSync(path.join(checkout, 'LOCAL-ONLY.txt'), 'unpushed work\n')
    })

    afterEach(function () {
        sinon.restore()
        if (root) fs.rmSync(root, { recursive: true, force: true })
    })

    it('keeps the checkout when the requested branch is absent from the remote', async function () {
        let threw = null
        try {
            await ms.cloneGit(MODULE, true, false, 'branch-only-on-this-box')
        } catch (err) { threw = err }

        expect(threw, 'clone must fail loudly').to.be.a('string')
        expect(threw).to.include('not found')
        expect(fs.existsSync(checkout), 'deploy checkout must survive a failed update').to.be.true
        expect(fs.existsSync(path.join(checkout, 'LOCAL-ONLY.txt')), 'checkout-only content must survive').to.be.true
        expect(fs.existsSync(path.join(checkout, '.git'))).to.be.true
    })

    it('keeps the checkout when the remote is unreachable', async function () {
        const gone = loadModuleService(modulesDir, tmpDir, path.join(root, 'no-such-remote'))
        let threw = null
        try {
            await gone.cloneGit(MODULE, true, false, null)
        } catch (err) { threw = err }

        expect(threw).to.include('Error cloning')
        expect(fs.existsSync(path.join(checkout, 'LOCAL-ONLY.txt'))).to.be.true
    })

    it('leaves no staging or backup directories behind after a failure', async function () {
        try {
            await ms.cloneGit(MODULE, true, false, 'branch-only-on-this-box')
        } catch { /* expected */ }
        const strays = fs.readdirSync(modulesDir).filter((e) => e !== MODULE)
        expect(strays).to.deep.equal([])
    })

    it('replaces the checkout with the freshly cloned source on success', async function () {
        // A successful update is still a full replacement: the new source is in
        // place and the previous checkout's untracked leftovers are gone.
        await ms.cloneGit(MODULE, true, false, 'master')
        expect(fs.existsSync(path.join(checkout, 'README.md'))).to.be.true
        expect(fs.existsSync(path.join(checkout, 'LOCAL-ONLY.txt'))).to.be.false
        const strays = fs.readdirSync(modulesDir).filter((e) => e !== MODULE)
        expect(strays).to.deep.equal([])
    })

    it('refuses a clone over an existing checkout when rewrite is off', async function () {
        let threw = null
        try {
            await ms.cloneGit(MODULE, false, false, null)
        } catch (err) { threw = err }
        expect(threw).to.include('already exists')
        expect(fs.existsSync(path.join(checkout, 'LOCAL-ONLY.txt'))).to.be.true
    })
})
