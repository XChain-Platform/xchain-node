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

const { installUnhandledRejectionHandler } = require('../../src/cli')

// : a failed `update` reached the operator as an ERR_UNHANDLED_REJECTION
// stack, because commander's parse() is synchronous and several services reject
// with a plain string. The backstop must turn that into a readable line and a
// non-zero exit.
describe('CLI unhandled-rejection backstop', function () {

    let installed, exitStub, errorStub

    beforeEach(function () {
        const before = process.listeners('unhandledRejection')
        installUnhandledRejectionHandler()
        installed = process.listeners('unhandledRejection').filter((l) => !before.includes(l))
        exitStub  = sinon.stub(process, 'exit')
        errorStub = sinon.stub(console, 'error')
    })

    afterEach(function () {
        for (const listener of installed) process.removeListener('unhandledRejection', listener)
        sinon.restore()
    })

    it('registers exactly one handler', function () {
        expect(installed).to.have.lengthOf(1)
    })

    it('prints a string reason readably and exits non-zero', function () {
        installed[0]("Error cloning project: branch 'xc952-mainnet-hotfix' not found for module 'xchain-hub'")
        expect(errorStub.calledOnce).to.be.true
        const line = errorStub.firstCall.args[0]
        expect(line).to.include('command failed')
        expect(line).to.include("branch 'xc952-mainnet-hotfix' not found")
        expect(line).to.not.include('[object Object]')
        expect(exitStub.calledWith(1)).to.be.true
    })

    it('keeps the stack when the reason is a real Error', function () {
        const err = new Error('genuine bug')
        installed[0](err)
        expect(errorStub.firstCall.args[0]).to.include('genuine bug')
        expect(errorStub.firstCall.args[0]).to.include('cli-error-handling.test.js')
        expect(exitStub.calledWith(1)).to.be.true
    })
})
