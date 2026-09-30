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
// Pins the lock `validator stake|unstake` hand their service: the CLI passes
// one to every run, and it takes the command lock once per hold and gives it back once.

const sinon       = require('sinon')
const { expect }  = require('chai')
const { Command } = require('commander')

const { validatorSendLock } = require('../../../src/cli/dispatch')
const { registerValidatorCommands } = require('../../../src/cli/output')

function lockDeps(config = {}) {
    const release = sinon.stub()
    return { release, config, acquireCommandLock: sinon.stub().returns(release) }
}

describe('CLI: validatorSendLock', function () {
    afterEach(function () { sinon.restore() })

    it('takes the lock once per hold, under the command\'s name, refusing a held one at once', function () {
        const deps = lockDeps()
        const lock = validatorSendLock('validator stake', deps)
        lock.hold()
        lock.hold()
        expect(deps.acquireCommandLock.calledOnceWith({ command: 'validator stake', waitMs: 0 })).to.be.true
        lock.release()
        lock.release()
        expect(deps.release.calledOnce).to.be.true
    })

    it('takes it again after a release, for the send that follows an index wait', function () {
        const deps = lockDeps()
        const lock = validatorSendLock('validator stake', deps)
        lock.hold()
        lock.release()
        lock.hold()
        expect(deps.acquireCommandLock.calledTwice).to.be.true
        lock.release()
    })

    it('waits as long as any mutator is told to wait for a held lock', function () {
        const deps = lockDeps({ XCHAIN_NODE_MUTATING_LOCK_WAIT_MS: '30000' })
        const lock = validatorSendLock('validator unstake', deps)
        lock.hold()
        expect(deps.acquireCommandLock.calledOnceWith({ command: 'validator unstake', waitMs: 30000 })).to.be.true
        lock.release()
    })

    it('releases on process exit while held, and drops that handler once released', function () {
        const deps = lockDeps()
        const before = process.listeners('exit').length
        const lock = validatorSendLock('validator stake', deps)
        lock.hold()
        expect(process.listeners('exit').length).to.equal(before + 1)
        lock.release()
        expect(process.listeners('exit').length).to.equal(before)
    })
})

describe('CLI: validator stake|unstake hand their service a send lock', function () {
    afterEach(function () { sinon.restore() })

    for (const [name, service, command] of [
        ['stake', 'stakeValidator', 'validator stake'],
        ['unstake', 'unstakeValidator', 'validator unstake']
    ]) {
        it(`validator ${name} --broadcast passes a lock named "${command}"`, async function () {
            sinon.stub(process, 'exit')
            const deps = lockDeps()
            deps[service] = sinon.stub().resolves({})
            const program = new Command()
            program.exitOverride()
            registerValidatorCommands(program, deps)
            await program.parseAsync(['validator', name, '--broadcast'], { from: 'user' })

            expect(deps[service].calledOnce).to.be.true
            const [opts, serviceDeps] = deps[service].firstCall.args
            expect(opts.broadcast).to.be.true
            serviceDeps.sendLock.hold()
            expect(deps.acquireCommandLock.calledOnceWith({ command, waitMs: 0 })).to.be.true
            serviceDeps.sendLock.release()
        })
    }
})
