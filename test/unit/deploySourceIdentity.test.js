'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Deploy-source identity: which COMMIT an update actually shipped.
//
// The failure this covers is not a crash. `update <module> <chain> regtest master`
// deployed a tree that was hours old, and every signal an operator or a test could
// read said it had worked: the container came up healthy, the image tag was the
// expected name, and the module's package.json version matched, because a release
// version stays put across dozens of commits. An acceptance test driven against
// that container measured code that was never deployed and passed.
//
// So the assertions here are about the two things that were missing: a deploy must
// SAY which commit it landed on, and it must REFUSE to be quietly older than the
// branch it was told to deploy.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const realConstants = require('../../src/config/constants')

const MODULE = 'xchain-indexer'
const DIR    = '/modules/' + MODULE
const TIP    = 'a'.repeat(40)
const OLD    = 'b'.repeat(40)

// Loads ModuleService with git fully faked on both call styles it uses: `git clone`
// through the callback execFile, everything else through the promisified one.
//
// `heads` is the sequence of commits the checkout reads back as, one per clone, so a
// re-clone can land somewhere different from the first attempt.
function load({ heads = [TIP], tip = TIP, sourceUrl = null, gitAsyncExtra = null, files = null, moduleDirExists = false } = {}) {
    const state = { clones: 0 }
    const asyncCalls = []

    const execFile = sinon.stub().callsFake((cmd, args, ...rest) => {
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        if (args[0] === 'clone') state.clones++
        if (args[0] === 'build' || args[0] === 'run') return cb(null, 'c'.repeat(64) + '\n')
        return cb(null, '', '')
    })

    const gitAsync = async (cmd, args) => {
        asyncCalls.push({ cmd, args })
        if (gitAsyncExtra) {
            const custom = gitAsyncExtra(args)
            if (custom !== undefined) return { stdout: custom }
        }
        if (args[0] === 'ls-remote') {
            return { stdout: tip ? tip + '\trefs/heads/master\n' : '' }
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
            const head = heads[Math.min(Math.max(state.clones - 1, 0), heads.length - 1)]
            return { stdout: head + '\n' }
        }
        if (args.includes('log')) {
            const head = heads[Math.min(Math.max(state.clones - 1, 0), heads.length - 1)]
            return { stdout: head + '\x1f2026-08-13T03:00:57-07:00\x1ffix(dispenser): an older commit\n' }
        }
        return { stdout: '' }
    }

    const fs = files || {
        existsSync:   sinon.stub().returns(true),
        rmSync:       sinon.stub(),
        mkdirSync:    sinon.stub(),
        readFileSync: sinon.stub(),
        cpSync:       sinon.stub(),
        renameSync:   sinon.stub()
    }

    const proxies = {
        'child_process': { execFile },
        'util': { promisify: () => gitAsync },
        'fs': fs,
        '../state': {
            db: { insertModuleContainer: sinon.stub().resolves(true), getModuleContainer: sinon.stub().resolves(null), removeModuleContainer: sinon.stub().resolves(true) },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir:    (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(moduleDirExists),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir:    sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: () => 'xchain-node-bitcoin-regtest-' + MODULE,
            getDockerNetwork: () => 'xchain-node-bitcoin-regtest',
            getUtxoTrackerVolumeName: () => 'vol',
            validatePort: () => true,
            getDefaultConfig: sinon.stub().resolves({})
        },
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': {
            killContainer: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            forceRemoveContainerByName: sinon.stub().resolves(true),
            getPublishedHostPorts: sinon.stub().resolves(new Map())
        },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
        './GoLiveGate': { assertGoLiveReady: () => {} }
    }

    if (sourceUrl) {
        proxies['../config/constants'] = Object.assign({}, realConstants, {
            modulesUrls: Object.assign({}, realConstants.modulesUrls, { [MODULE]: sourceUrl })
        })
    }

    const ms = proxyquire('../../src/services/ModuleService', proxies)
    return { ms, state, execFile, fs, asyncCalls }
}

describe('deploy source identity', function () {

    let logs, warns

    beforeEach(function () {
        logs  = []
        warns = []
        sinon.stub(console, 'log').callsFake((...a) => logs.push(a.join(' ')))
        sinon.stub(console, 'warn').callsFake((...a) => warns.push(a.join(' ')))
    })

    afterEach(function () {
        sinon.restore()
    })

    describe('reporting', function () {

        it('names the full commit, its date and its subject on every deploy clone', async function () {
            const { ms } = load({ heads: [TIP], tip: TIP })
            await ms.cloneGit(MODULE, false, false, 'master')
            const line = logs.find(l => l.includes('Deploy source'))
            expect(line, 'no deploy-source line was printed at all').to.be.a('string')
            expect(line).to.include(MODULE)
            expect(line).to.include(TIP)
            expect(line).to.include('2026-08-13T03:00:57-07:00')
            expect(line).to.include('fix(dispenser): an older commit')
        })

        it('reports after the swap on a rewrite over an existing checkout', async function () {
            const { ms } = load({ heads: [TIP], tip: TIP, moduleDirExists: true })
            await ms.cloneGit(MODULE, true, false, 'master')
            expect(logs.some(l => l.includes('Deploy source') && l.includes(TIP))).to.equal(true)
        })
    })

    describe('freshness of a named branch', function () {

        it('accepts a clone that landed on the branch tip, with no second clone', async function () {
            const { ms, state } = load({ heads: [TIP], tip: TIP })
            const ok = await ms.cloneGit(MODULE, false, false, 'master')
            expect(ok).to.equal(true)
            expect(state.clones).to.equal(1)
        })

        it('re-clones ONCE when the clone landed behind the branch tip', async function () {
            // First clone resolves 'master' to an older commit, second gets the tip.
            const { ms, state } = load({ heads: [OLD, TIP], tip: TIP })
            const ok = await ms.cloneGit(MODULE, false, false, 'master')
            expect(ok).to.equal(true)
            expect(state.clones).to.equal(2)
            expect(warns.some(w => w.includes(OLD.slice(0, 12)) && w.includes(TIP.slice(0, 12)))).to.equal(true)
        })

        it('REFUSES the deploy when the ref keeps resolving to a stale commit', async function () {
            // This is the case that shipped: the tree is old, but nothing downstream
            // can tell, so the only safe outcome is to deploy nothing.
            const { ms, state } = load({ heads: [OLD, OLD], tip: TIP })
            let threw = null
            try {
                await ms.cloneGit(MODULE, false, false, 'master')
            } catch (err) { threw = err }
            expect(threw, 'a stale clone was accepted').to.be.an('error')
            expect(threw.message).to.include('Stale source')
            expect(threw.message).to.include(OLD.slice(0, 12))
            expect(threw.message).to.include(TIP.slice(0, 12))
            expect(threw.message).to.include('Nothing has been deployed')
            expect(state.clones).to.equal(2)
        })

        it('does not check a branch tip for a manifest-pinned install', async function () {
            // A pin names a commit and assertCheckoutCommit already proved it; a tag
            // has no branch tip to compare against.
            const { ms, asyncCalls } = load({ heads: [TIP], tip: TIP })
            await ms.cloneGit(MODULE, false, false, 'v0.9.0', TIP)
            expect(asyncCalls.some(c => c.args[0] === 'ls-remote')).to.equal(false)
        })

        it('proceeds when the source cannot be queried, rather than failing the deploy', async function () {
            const { ms, state } = load({ heads: [TIP], tip: null })
            const ok = await ms.cloneGit(MODULE, false, false, 'master')
            expect(ok).to.equal(true)
            expect(state.clones).to.equal(1)
        })

        it('leaves the version-probe clone in tmp alone', async function () {
            // The tmp tree feeds `ps` version columns, not a deploy; adding a network
            // round trip there would tax every status refresh for nothing.
            const { ms, asyncCalls } = load({ heads: [TIP], tip: TIP })
            await ms.cloneGit(MODULE, false, true, 'master')
            expect(asyncCalls.some(c => c.args[0] === 'ls-remote')).to.equal(false)
        })
    })

    describe('local-path source behind its own upstream', function () {

        it('warns, naming both commits and how far behind the checkout is', async function () {
            // XCHAIN_NODE_MODULES_URLS_OVERRIDE clones a LOCAL checkout by its own
            // refs, so 'master' there is that checkout's master, not the upstream's.
            const { ms } = load({
                heads: [OLD],
                tip: OLD,
                sourceUrl: '/srv/checkouts/xchain-indexer',
                gitAsyncExtra: (args) => {
                    if (args.includes('rev-parse') && args.includes('refs/heads/master')) return OLD + '\n'
                    if (args.includes('rev-parse') && args.includes('refs/remotes/origin/master')) return TIP + '\n'
                    if (args.includes('rev-list')) return '7\n'
                    return undefined
                }
            })
            await ms.cloneGit(MODULE, false, false, 'master')
            const warned = warns.find(w => w.includes('BEHIND'))
            expect(warned, 'a behind local source deployed silently').to.be.a('string')
            expect(warned).to.include('7 commit')
            expect(warned).to.include(OLD.slice(0, 12))
            expect(warned).to.include(TIP.slice(0, 12))
        })

        it('says nothing when the local checkout is level with its upstream', async function () {
            const { ms } = load({
                heads: [TIP],
                tip: TIP,
                sourceUrl: '/srv/checkouts/xchain-indexer',
                gitAsyncExtra: (args) => {
                    if (args.includes('rev-parse')) return TIP + '\n'
                    if (args.includes('rev-list')) return '0\n'
                    return undefined
                }
            })
            await ms.cloneGit(MODULE, false, false, 'master')
            expect(warns.some(w => w.includes('BEHIND'))).to.equal(false)
        })

        it('does not probe a remote URL source for a local upstream', async function () {
            const { ms, asyncCalls } = load({ heads: [TIP], tip: TIP })
            await ms.cloneGit(MODULE, false, false, 'master')
            expect(asyncCalls.some(c => c.args.includes('rev-list'))).to.equal(false)
        })
    })

    describe('image stamping', function () {

        // A checkout on disk: HEAD points at a branch, the branch ref holds the commit.
        function checkoutFiles({ headFile = 'ref: refs/heads/master\n', refFile = TIP + '\n', packed = null } = {}) {
            const readFileSync = sinon.stub().callsFake((p) => {
                if (String(p).endsWith('/.git/HEAD')) return headFile
                if (String(p).endsWith('/.git/refs/heads/master')) {
                    if (refFile === null) throw new Error('ENOENT')
                    return refFile
                }
                if (String(p).endsWith('/.git/packed-refs')) {
                    if (packed === null) throw new Error('ENOENT')
                    return packed
                }
                throw new Error('ENOENT: ' + p)
            })
            return { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub(), readFileSync, cpSync: sinon.stub(), renameSync: sinon.stub() }
        }

        function buildArgsFrom(execFile) {
            const call = execFile.getCalls().find(c => c.args[1][0] === 'build')
            return call ? call.args[1] : null
        }

        it('labels the image with the commit it was built from', async function () {
            const { ms, execFile } = load({ files: checkoutFiles() })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            const args = buildArgsFrom(execFile)
            expect(args).to.include('--label')
            expect(args).to.include('xchain.source.commit=' + TIP)
            expect(args).to.include('xchain.source.ref=master')
        })

        it('finds the commit when the branch ref is packed rather than loose', async function () {
            const { ms, execFile } = load({
                files: checkoutFiles({ refFile: null, packed: '# pack-refs with: peeled fully-peeled sorted \n' + TIP + ' refs/heads/master\n' })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            expect(buildArgsFrom(execFile)).to.include('xchain.source.commit=' + TIP)
        })

        it('labels a detached checkout with its commit and no ref', async function () {
            const { ms, execFile } = load({ files: checkoutFiles({ headFile: TIP + '\n' }) })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            const args = buildArgsFrom(execFile)
            expect(args).to.include('xchain.source.commit=' + TIP)
            expect(args.some(a => String(a).startsWith('xchain.source.ref='))).to.equal(false)
        })

        it('builds without labels rather than failing when the checkout is unreadable', async function () {
            const files = checkoutFiles()
            files.readFileSync = sinon.stub().throws(new Error('EACCES'))
            const { ms, execFile } = load({ files })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            const args = buildArgsFrom(execFile)
            expect(args).to.not.equal(null)
            expect(args.some(a => String(a).startsWith('xchain.source.'))).to.equal(false)
        })

        it('does not re-stamp an image it is reusing', async function () {
            // `recreate` keeps the existing image on purpose. Stamping it with whatever
            // the checkout holds today would make the label claim code the running
            // container was never built from, which is the lie this label exists to end.
            const { ms, execFile } = load({ files: checkoutFiles() })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest', null, false, null, { reuseImage: true })
            expect(buildArgsFrom(execFile)).to.equal(null)
            const runCall = execFile.getCalls().find(c => c.args[1][0] === 'run')
            expect(runCall).to.not.equal(undefined)
        })
    })
})
