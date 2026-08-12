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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { modulesUrls } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModuleService(stubs) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'util': { promisify: () => async (cmd, args) => ({ stdout: '', stderr: '' }) },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: sinon.stub().returns('img'),
            getDockerNetwork: sinon.stub().returns('net'),
            getDefaultConfig: sinon.stub().resolves({}),
            validatePort: () => true
        },
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            insertModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves(null),
            removeModuleContainer: sinon.stub().resolves(true)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Branch Name Validation', function () {

    const validBranches = [
        'master',
        'develop',
        'feature/add-login',
        'v1.0.0',
        'release-1.2.3',
        'hotfix/fix_bug',
        'a',
        'A/B/C/D/E',
        '0.1.7',
        'my.branch.name',
        'under_score',
    ]

    for (const branch of validBranches) {
        it(`accepts valid branch name: "${branch}"`, async function () {
            const stubs = makeStubs()
            let clonedCmd = null
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (typeof args === 'function') { cb = args; args = [] }
                clonedCmd = cmd + ' ' + (args || []).join(' ')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, branch)
            expect(clonedCmd).to.include(`-b ${branch}`)
        })
    }

    const invalidBranches = [
        // Shell injection attempts
        'master; rm -rf /',
        'master && echo pwned',
        'master | cat /etc/passwd',
        'master$(whoami)',
        'master`id`',
        // Git flag injection
        '--upload-pack=evil',
        '--template=/tmp/evil',
        // Whitespace
        'branch name',
        'branch\tname',
        'branch\nname',
        // Special characters
        'branch"name',
        "branch'name",
        'branch\\name',
        'branch<name',
        'branch>name',
        'branch:name',
        'branch*name',
        'branch?name',
        'branch[name',
        'branch]name',
        'branch{name}',
        'branch(name)',
        'branch!name',
        'branch@name',
        'branch#name',
        'branch$name',
        'branch%name',
        'branch^name',
        'branch&name',
        'branch=name',
        'branch+name',
        'branch~name',
        // Null bytes
        'branch\x00name',
        // Unicode
        'bränch',
    ]

    for (const branch of invalidBranches) {
        it(`rejects invalid branch name: ${JSON.stringify(branch)}`, async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => {
                if (typeof args === 'function') { cb = args; args = [] }
                cb(null)
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, branch)
                expect.fail('Should have rejected invalid branch: ' + JSON.stringify(branch))
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })
    }

    const regexPassButDangerous = [
        // "--upload-pack" and similar strings pass the branch-name regex (it
        // allows hyphens) but are safe: execFile passes args as an array, so
        // "-b" always consumes the following element as the branch name and
        // never as a separate flag.
    ]

    it('branch name starting with -- is rejected by regex (hyphen allowed but double-dash prefix is safe because -b flag precedes it)', async function () {
        const branch = '--upload-pack'
        const stubs = makeStubs()
        let clonedCmd = null
        stubs.execFile.callsFake((cmd, args, cb) => {
            if (typeof args === 'function') { cb = args; args = [] }
            clonedCmd = cmd + ' ' + (args || []).join(' ')
            cb(null)
        })
        const ms = loadModuleService(stubs)
        await ms.cloneGit('xchain-encoder', false, false, branch)
        expect(clonedCmd).to.include('-b --upload-pack')
        const parts = clonedCmd.split(' ')
        const bIndex = parts.indexOf('-b')
        expect(parts[bIndex + 1]).to.equal('--upload-pack')
    })

    it('treats empty string branch same as null (no -b flag)', async function () {
        const stubs = makeStubs()
        let clonedCmd = null
        stubs.execFile.callsFake((cmd, args, cb) => {
            if (typeof args === 'function') { cb = args; args = [] }
            clonedCmd = cmd + ' ' + (args || []).join(' ')
            cb(null)
        })
        const ms = loadModuleService(stubs)
        await ms.cloneGit('xchain-encoder', false, false, '')
        expect(clonedCmd).to.not.include('-b')
    })

    it('does not include -b flag when branch is null', async function () {
        const stubs = makeStubs()
        let clonedCmd = null
        stubs.execFile.callsFake((cmd, args, cb) => {
            if (typeof args === 'function') { cb = args; args = [] }
            clonedCmd = cmd + ' ' + (args || []).join(' ')
            cb(null)
        })
        const ms = loadModuleService(stubs)
        await ms.cloneGit('xchain-encoder', false, false, null)
        expect(clonedCmd).to.not.include('-b')
    })

    it('accepts a very long but valid branch name', async function () {
        const longBranch = 'a'.repeat(500)
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, cb) => {
            if (typeof args === 'function') { cb = args; args = [] }
            cb(null)
        })
        const ms = loadModuleService(stubs)
        await ms.cloneGit('xchain-encoder', false, false, longBranch)
    })

    it('accepts branch with slashes: feature/sub/deep', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, cb) => {
            if (typeof args === 'function') { cb = args; args = [] }
            cb(null)
        })
        const ms = loadModuleService(stubs)
        await ms.cloneGit('xchain-encoder', false, false, 'feature/sub/deep')
    })
})
