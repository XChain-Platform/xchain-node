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
// The CLI is the release carrier, so `update` moves the CLI first and hands
// the command to the code at the target release. Every step here is a refusal
// or a no-op except the one that moves the checkout, and that one must be able
// to put the previous commit back.

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function load(dataDir) {
    return proxyquire('../../src/services/SelfUpdateService', {
        '../config/constants': { dataDir }
    })
}

// A fake git/npm: answers by argv shape and records every call.
function fakeExec(answers = {}) {
    const calls = []
    const run = sinon.stub().callsFake(async (bin, args) => {
        calls.push([bin, ...args])
        const key = bin === 'git' ? args.slice(2).join(' ') : bin
        for (const pattern of Object.keys(answers)) {
            if (key.startsWith(pattern)) {
                const answer = answers[pattern]
                if (answer instanceof Error) throw answer
                return { stdout: typeof answer === 'function' ? answer() : answer }
            }
        }
        return { stdout: '' }
    })
    run.calls = calls
    return run
}

function fakeChild(exitCode = 0) {
    const handlers = {}
    const child = { on: (event, fn) => { handlers[event] = fn; if (event === 'exit') setImmediate(() => fn(exitCode)) } }
    return child
}

describe('SelfUpdateService', function () {
    let workDir, dataDir, svc, logger, env

    beforeEach(function () {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-selfupd-'))
        dataDir = path.join(workDir, 'data')
        svc     = load(dataDir)
        logger  = { log: sinon.stub(), warn: sinon.stub(), error: sinon.stub() }
        env     = {}
    })

    afterEach(function () {
        fs.rmSync(workDir, { recursive: true, force: true })
        sinon.restore()
    })

    describe('compareVersions()', function () {
        it('orders numeric triples and ignores a leading v', function () {
            expect(svc.compareVersions('0.15.2', 'v0.15.2')).to.equal(0)
            expect(svc.compareVersions('0.12.3', 'v0.15.2')).to.equal(-1)
            expect(svc.compareVersions('v1.0.0', '0.99.99')).to.equal(1)
            expect(svc.compareVersions('0.15.10', '0.15.9')).to.equal(1)
        })
    })

    describe('selfUpdateAndReexec()', function () {

        function deps(overrides = {}) {
            return {
                env, logger, root: workDir,
                currentVersion: () => '0.12.3',
                describeCarrier: sinon.stub().resolves({ isRepo: true, commit: 'c'.repeat(40), dirty: [] }),
                execFile: fakeExec(),
                verifyGitTagSignature: sinon.stub().returns({ fingerprint: 'F'.repeat(40) }),
                signatureCheckDisabled: () => false,
                spawn: sinon.stub().returns(fakeChild(0)),
                exit: sinon.stub(),
                ...overrides
            }
        }

        it('does nothing inside the re-executed child (loop guard)', async function () {
            env[svc.TARGET_ENV] = 'v0.15.2'
            const d = deps()
            const out = await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d })
            expect(out).to.deep.equal({ moved: false, reason: 'already-reexecuted' })
            expect(d.execFile.called).to.equal(false)
        })

        it('does nothing when told not to, and says so', async function () {
            env[svc.NO_SELF_UPDATE_ENV] = '1'
            const d = deps()
            const out = await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d })
            expect(out.reason).to.equal('disabled')
            expect(logger.log.firstCall.args[0]).to.match(/XCHAIN_NODE_NO_SELF_UPDATE/)
            expect(d.execFile.called).to.equal(false)
        })

        it('does nothing when the CLI already runs the target version', async function () {
            const d = deps({ currentVersion: () => '0.15.2' })
            const out = await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d })
            expect(out.reason).to.equal('current')
            expect(d.describeCarrier.called).to.equal(false)
        })

        it('warns and continues when the CLI is not a git checkout', async function () {
            const d = deps({ describeCarrier: sinon.stub().resolves({ isRepo: false, commit: null, dirty: [] }) })
            const out = await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d })
            expect(out.reason).to.equal('not-a-checkout')
            expect(logger.warn.calledOnce).to.equal(true)
            expect(d.execFile.called).to.equal(false)
        })

        it('refuses a dirty tracked tree with nothing changed', async function () {
            const d = deps({ describeCarrier: sinon.stub().resolves({ isRepo: true, commit: 'c'.repeat(40), dirty: ['src/cli.js'] }) })
            let err = null
            try { await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d }) } catch (e) { err = e }
            expect(err).to.not.equal(null)
            expect(err.message).to.match(/src\/cli\.js/)
            expect(err.message).to.match(/Nothing was changed/)
            expect(d.execFile.called).to.equal(false)
        })

        it('fetches, verifies the tag, checks it out, installs, hands back the lock and re-executes the explicit command', async function () {
            const beforeSpawn = sinon.stub()
            const d = deps({ beforeSpawn })
            await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update', 'all', 'all', 'all', 'v0.15.2'], deps: d })

            const calls = d.execFile.calls
            expect(calls[0].slice(0, 1).concat(calls[0].slice(3))).to.deep.equal(['git', 'fetch', '--tags', '--force', '--quiet', 'origin'])
            expect(d.verifyGitTagSignature.calledWith(sinon.match({ tag: 'v0.15.2', repoDir: workDir }))).to.equal(true)
            expect(d.verifyGitTagSignature.calledAfter(d.execFile)).to.equal(true)
            expect(calls[1].slice(3)).to.deep.equal(['checkout', '--detach', '--quiet', 'v0.15.2'])
            expect(calls[2][0]).to.equal('npm')
            expect(calls[2]).to.include('install')
            expect(beforeSpawn.calledOnce).to.equal(true)
            expect(beforeSpawn.calledBefore(d.spawn)).to.equal(true)

            const [bin, argv, opts] = d.spawn.firstCall.args
            expect(bin).to.equal(process.execPath)
            expect(argv.slice(1)).to.deep.equal(['update', 'all', 'all', 'all', 'v0.15.2'])
            expect(opts.env[svc.TARGET_ENV]).to.equal('v0.15.2')
            expect(opts.stdio).to.equal('inherit')
            expect(d.exit.calledWith(0)).to.equal(true)
        })

        it('exits with the child status', async function () {
            const d = deps({ spawn: sinon.stub().returns(fakeChild(3)) })
            await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d })
            expect(d.exit.calledWith(3)).to.equal(true)
        })

        it('refuses a tag the release key did not sign, before anything is checked out', async function () {
            const d = deps({ verifyGitTagSignature: sinon.stub().throws(new Error('Tag v0.15.2 is signed, but not by the pinned release key.')) })
            let err = null
            try { await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d }) } catch (e) { err = e }
            expect(err.message).to.match(/not by the pinned release key/)
            expect(d.execFile.calls.some(c => c.includes('checkout'))).to.equal(false)
            expect(d.spawn.called).to.equal(false)
        })

        it('moves anyway, loudly, when signature checks are switched off', async function () {
            const d = deps({
                verifyGitTagSignature: sinon.stub().throws(new Error('gpg is not installed')),
                signatureCheckDisabled: () => true
            })
            await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d })
            expect(logger.warn.calledWithMatch(/WITHOUT verifying its tag/)).to.equal(true)
            expect(d.spawn.calledOnce).to.equal(true)
        })

        it('puts the previous commit back when npm install fails', async function () {
            const d = deps({ execFile: fakeExec({ npm: new Error('ERESOLVE') }) })
            let err = null
            try { await svc.selfUpdateAndReexec({ tag: 'v0.15.2', childArgs: ['update'], deps: d }) } catch (e) { err = e }
            expect(err.message).to.match(/npm install failed/)
            const last = d.execFile.calls[d.execFile.calls.length - 1]
            expect(last.slice(3)).to.deep.equal(['checkout', '--detach', '--quiet', 'c'.repeat(40)])
            expect(d.spawn.called).to.equal(false)
        })
    })

    describe('explicitUpdateArgs()', function () {
        it('always names every slot and the tag, whatever the operator typed', function () {
            expect(svc.explicitUpdateArgs({ service: 'all', chain: 'all', network: 'all' }, 'v0.15.2'))
                .to.deep.equal(['update', 'all', 'all', 'all', 'v0.15.2'])
            expect(svc.explicitUpdateArgs({ service: 'xchain-hub', chain: 'all', network: 'all' }, 'v0.15.2'))
                .to.deep.equal(['update', 'xchain-hub', 'all', 'all', 'v0.15.2'])
        })
    })

    describe('describeCarrier()', function () {
        it('answers not-a-repo when git refuses', async function () {
            const d = { root: workDir, execFile: fakeExec({ 'rev-parse --is-inside-work-tree': new Error('fatal: not a git repository') }) }
            expect(await svc.describeCarrier(d)).to.deep.equal({ isRepo: false, commit: null, dirty: [] })
        })

        it('lists dirty tracked files and the current commit', async function () {
            const d = { root: workDir, execFile: fakeExec({
                'rev-parse --is-inside-work-tree': 'true\n',
                'rev-parse HEAD': 'a'.repeat(40) + '\n',
                'status --porcelain': ' M src/cli.js\nM  package.json\n'
            }) }
            expect(await svc.describeCarrier(d)).to.deep.equal({ isRepo: true, commit: 'a'.repeat(40), dirty: ['src/cli.js', 'package.json'] })
        })
    })

    describe('noticeNewerRelease()', function () {

        it('prints one line naming the newer release and the command to run', async function () {
            const resolve = sinon.stub().resolves('v0.15.2')
            const tag = await svc.noticeNewerRelease({ env, logger, currentVersion: () => '0.12.3', resolveLatestReleaseTag: resolve, now: () => 1000 })
            expect(tag).to.equal('v0.15.2')
            expect(logger.log.calledOnce).to.equal(true)
            expect(logger.log.firstCall.args[0]).to.match(/v0\.15\.2/)
            expect(logger.log.firstCall.args[0]).to.match(/v0\.12\.3/)
            expect(logger.log.firstCall.args[0]).to.match(/xchain-node update all/)
        })

        it('stays silent when current', async function () {
            const resolve = sinon.stub().resolves('v0.15.2')
            const tag = await svc.noticeNewerRelease({ env, logger, currentVersion: () => '0.15.2', resolveLatestReleaseTag: resolve })
            expect(tag).to.equal(null)
            expect(logger.log.called).to.equal(false)
        })

        it('stays silent inside an update and never asks the network there', async function () {
            env[svc.TARGET_ENV] = 'v0.15.2'
            const resolve = sinon.stub().resolves('v0.15.2')
            await svc.noticeNewerRelease({ env, logger, currentVersion: () => '0.12.3', resolveLatestReleaseTag: resolve })
            expect(resolve.called).to.equal(false)
        })

        it('caches the lookup for an hour, including a failed one', async function () {
            const resolve = sinon.stub().rejects(new Error('rate limited'))
            let now = 1000
            const d = { env, logger, currentVersion: () => '0.12.3', resolveLatestReleaseTag: resolve, now: () => now }
            expect(await svc.noticeNewerRelease(d)).to.equal(null)
            expect(await svc.noticeNewerRelease(d)).to.equal(null)
            expect(resolve.calledOnce, 'the failure is cached').to.equal(true)
            now += svc.CHECK_TTL_MS + 1
            resolve.resolves('v0.15.2')
            expect(await svc.noticeNewerRelease(d)).to.equal('v0.15.2')
            expect(resolve.calledTwice).to.equal(true)
            expect(fs.existsSync(path.join(dataDir, svc.CHECK_CACHE_FILE))).to.equal(true)
        })

        it('gives up on a slow lookup rather than holding the command', async function () {
            const resolve = sinon.stub().returns(new Promise(() => {}))
            const tag = await svc.noticeNewerRelease({ env, logger, currentVersion: () => '0.12.3', resolveLatestReleaseTag: resolve, timeoutMs: 5 })
            expect(tag).to.equal(null)
        })
    })
})
