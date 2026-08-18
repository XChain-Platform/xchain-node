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
const { refForPreCheck } = require('../../src/cli')

const cmd = (args) => ({ args })

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
