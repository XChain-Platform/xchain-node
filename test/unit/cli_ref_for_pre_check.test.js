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
// refForPreCheck decides which ref the hub is staged from, because preCheck
// provisions the hub before commander parses the action's arguments. Measured
// 2026-08-18: without it `install develop all bitcoin regtest` deployed a MASTER
// hub into a develop stack, and the hub is the config oracle the rest of the
// stack reads. The install args are order-independent, so the classification is
// delegated to resolveArgs and these cases pin that delegation: the danger is not
// a wrong answer, it is a confident one (`install regtest` naming a network that
// a "first positional" reading would install the hub from).

const { expect } = require('chai')
const { refForPreCheck, commandRepairsHub } = require('../../src/cli')

const cmd = (args) => ({ args })
// Commander hands the hook an action command whose opts() carry the flags; only
// `uninstall --include-shared` is read here.
const cmdWithOpts = (args, opts) => ({ args, opts: () => opts })

describe('cli refForPreCheck()', function () {

    it('reads the branch out of a full install invocation', function () {
        expect(refForPreCheck('install', cmd(['develop', 'all', 'bitcoin', 'regtest']))).to.equal('develop')
    })

    it('reads a release branch, which is what the ceremony freeze gate installs', function () {
        expect(refForPreCheck('install', cmd(['release/v0.10.0', 'all', 'bitcoin', 'regtest']))).to.equal('release/v0.10.0')
    })

    it('reads a release TAG, so a pinned install stages the pinned hub', function () {
        expect(refForPreCheck('install', cmd(['v0.9.0', 'all', 'bitcoin', 'regtest']))).to.equal('v0.9.0')
    })

    it('finds the ref regardless of argument order', function () {
        expect(refForPreCheck('install', cmd(['bitcoin', 'regtest', 'develop']))).to.equal('develop')
    })

    it('returns null when every argument is a known service/chain/network', function () {
        // `install regtest` names a NETWORK. A naive first-positional read would
        // hand "regtest" to the hub clone as a branch name.
        expect(refForPreCheck('install', cmd(['regtest']))).to.equal(null)
        expect(refForPreCheck('install', cmd(['all', 'bitcoin', 'regtest']))).to.equal(null)
    })

    it('returns null for an install with no arguments at all', function () {
        expect(refForPreCheck('install', cmd([]))).to.equal(null)
        expect(refForPreCheck('install', cmd(undefined))).to.equal(null)
    })

    it('applies to update as well, which also takes a ref', function () {
        expect(refForPreCheck('update', cmd(['develop', 'xchain-indexer']))).to.equal('develop')
    })

    it('returns null for every command that does not install at a ref', function () {
        for (const name of ['ps', 'start', 'stop', 'e2etest', 'uninstall', 'reset']) {
            expect(refForPreCheck(name, cmd(['develop']))).to.equal(null, name)
        }
    })

    it('swallows a resolveArgs refusal rather than aborting before the action can report it', function () {
        // 'xchain-node' makes resolveArgs throw (it is the CLI, not a module). The
        // action raises that with full context; this helper must not pre-empt it
        // with a stack trace from a precheck hook.
        expect(refForPreCheck('install', cmd(['xchain-node']))).to.equal(null)
    })
})

// commandRepairsHub decides which commands survive a hub that is not answering.
//
// preCheck pushes local config to the hub before every state-changing command.
// A crash-looping hub answers nothing, so that push failed after ten attempts
// and aborted the command - `update xchain-hub` included, which is the command
// that rebuilds the hub and ends the crash loop. Deleting the container by hand
// was the only escape. The answer here buys a SKIPPED config push, so it has to
// be narrow in both directions: too wide silences a real hub failure on a
// command that needs one working, too narrow wedges the repair path again.
describe('cli commandRepairsHub()', function () {

    describe('says yes when the command reaches the hub container', function () {

        it('for the hub named outright on every verb that replaces or restarts it', function () {
            for (const name of ['install', 'update', 'recreate', 'restart', 'start', 'uninstall']) {
                expect(commandRepairsHub(name, cmd(['xchain-hub']))).to.equal(true, name)
            }
        })

        it('through the short alias operators actually type', function () {
            expect(commandRepairsHub('recreate', cmd(['hub']))).to.equal(true)
            expect(commandRepairsHub('update', cmd(['hub']))).to.equal(true)
        })

        it('for `update` with no service, which is the documented whole-node upgrade', function () {
            // Bare `update` resolves to `all`, and `all` on THIS verb folds the
            // shared services in hub-first (includeSharedServicesForUpdate).
            expect(commandRepairsHub('update', cmd([]))).to.equal(true)
            expect(commandRepairsHub('update', cmd(['all']))).to.equal(true)
        })

        it('for `update` at a named ref, where the ref is not a service', function () {
            expect(commandRepairsHub('update', cmd(['xchain-hub', 'v0.16.2']))).to.equal(true)
            expect(commandRepairsHub('update', cmd(['develop']))).to.equal(true)
        })

        it('for `uninstall all --include-shared`, the teardown that removes the hub', function () {
            expect(commandRepairsHub('uninstall', cmdWithOpts(['all'], { includeShared: true }))).to.equal(true)
        })

        it('for autoheal, whose whole job is restarting containers that are unhealthy', function () {
            expect(commandRepairsHub('autoheal', cmd([]))).to.equal(true)
        })
    })

    describe('says no when the command needs a hub it cannot fix', function () {

        it('for every verb that only reads or writes THROUGH the hub', function () {
            for (const name of ['ps', 'reset', 'sync', 'bootstrap', 'e2etest', 'exec', 'shell', 'logs',
                                'tail', 'monitor', 'clear-reorg-halt', 'rollback', 'validator']) {
                expect(commandRepairsHub(name, cmd(['xchain-hub']))).to.equal(false, name)
            }
        })

        it('for `stop`, which takes the hub down rather than bringing it back', function () {
            expect(commandRepairsHub('stop', cmd(['xchain-hub']))).to.equal(false)
            expect(commandRepairsHub('stop', cmd(['all']))).to.equal(false)
        })

        it('when a repairing verb targets some OTHER service', function () {
            expect(commandRepairsHub('restart', cmd(['xchain-indexer', 'bitcoin', 'regtest']))).to.equal(false)
            expect(commandRepairsHub('recreate', cmd(['xchain-explorer']))).to.equal(false)
            expect(commandRepairsHub('update', cmd(['xchain-decoder', 'litecoin']))).to.equal(false)
            expect(commandRepairsHub('install', cmd(['develop', 'node', 'bitcoin', 'regtest']))).to.equal(false)
        })

        it('for `all` on the verbs whose expansion leaves the hub out', function () {
            // filterCommandParameters expands `all` to the coin stacks plus the
            // explorer; the hub is a shared service and is never in it. Only
            // `update` adds it back, and it has its own case above.
            for (const name of ['install', 'recreate', 'restart', 'start']) {
                expect(commandRepairsHub(name, cmd(['all', 'bitcoin', 'regtest']))).to.equal(false, name)
            }
        })

        it('for `uninstall all` without the shared flag, which leaves the hub standing', function () {
            expect(commandRepairsHub('uninstall', cmdWithOpts(['all'], { includeShared: false }))).to.equal(false)
            expect(commandRepairsHub('uninstall', cmd(['all']))).to.equal(false)
        })

        it('when resolveArgs refuses the argument shape', function () {
            // The action raises that refusal itself with full context; a precheck
            // hook must not turn an unparsable command into a licence to skip.
            expect(commandRepairsHub('update', cmd(['xchain-node']))).to.equal(false)
            expect(commandRepairsHub('restart', cmd(['not-a-service']))).to.equal(false)
        })

        it('tolerates a missing args array rather than throwing inside the hook', function () {
            expect(commandRepairsHub('restart', cmd(undefined))).to.equal(false)
            expect(commandRepairsHub('restart', undefined)).to.equal(false)
        })
    })
})
