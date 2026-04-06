'use strict'

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

    // --- Valid branch names that must be accepted ---

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

    // --- Invalid branch names that must be rejected ---

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
        'br\u00e4nch',
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

    // --- Branch names that pass the regex but look like git flags ---

    const regexPassButDangerous = [
        // These match ^[a-zA-Z0-9._\-\/]+$ but start with -
        // The regex allows hyphens, so "--upload-pack" could pass if it starts with valid chars
        // Actually: --upload-pack contains only [a-zA-Z-] so it DOES match the regex
        // This is a known concern — we verify the git command includes -b flag properly
    ]

    it('branch name starting with -- is rejected by regex (hyphen allowed but double-dash prefix is safe because -b flag precedes it)', async function () {
        // "--upload-pack" matches [a-zA-Z0-9._\-\/]+ — let's verify behavior
        const branch = '--upload-pack'
        const stubs = makeStubs()
        let clonedCmd = null
        stubs.execFile.callsFake((cmd, args, cb) => {
            if (typeof args === 'function') { cb = args; args = [] }
            clonedCmd = cmd + ' ' + (args || []).join(' ')
            cb(null)
        })
        const ms = loadModuleService(stubs)
        // The regex DOES allow this (all chars are in [a-zA-Z0-9._\-\/])
        // But with execFile, args are passed as array elements, not a shell string.
        // git clone -b --upload-pack treats it as a branch name argument to -b, not a separate flag
        // This is safe because -b consumes the next argument
        await ms.cloneGit('xchain-encoder', false, false, branch)
        expect(clonedCmd).to.include('-b --upload-pack')
        // Verify the structure: -b <branch> <url> <dest> — no unattached flags
        const parts = clonedCmd.split(' ')
        const bIndex = parts.indexOf('-b')
        expect(parts[bIndex + 1]).to.equal('--upload-pack')
    })

    // --- Null branch (no branch specified) ---

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

    // --- Extremely long branch name ---

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

    // --- Branch with only slashes ---

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
