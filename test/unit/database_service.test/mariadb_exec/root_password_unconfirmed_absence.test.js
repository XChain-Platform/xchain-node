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

const { expect, makeStubs, loadDatabaseService } = require('../helpers/harness')

// Run askMariadbRootPassword with the container id lookup failing (null id), docker's
// tri-state presence answer injected, and the env override and stdin TTY set as asked.
async function resolveWithPresence({ presence, presenceThrows = false, envPassword = null, tty = false }) {
    const stubs = makeStubs()
    stubs.getDbRootPassword.returns(null)
    stubs.execFileAsync.rejects(new Error('Cannot connect to the Docker daemon'))
    if (presenceThrows) stubs.probeContainerPresenceByName.rejects(new Error('docker hung'))
    else stubs.probeContainerPresenceByName.resolves(presence)
    const savedEnv = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
    if (envPassword === null) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
    else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = envPassword
    const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
    try {
        const ds = loadDatabaseService(stubs)
        let err = null
        let result = null
        try { result = await ds.askMariadbRootPassword('bitcoin', 'mainnet') } catch (e) { err = e }
        return { stubs, err, result }
    } finally {
        if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
        else delete process.stdin.isTTY
        if (savedEnv === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
        else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = savedEnv
    }
}

function expectRefusedWithNothingSaved({ stubs, err }, presence) {
    expect(err, 'an unconfirmed absence must refuse').to.be.an('error')
    expect(err.message).to.include(`Docker reported '${presence}'`)
    expect(err.message).to.not.include('env-root-pass')
    expect(stubs.setDbRootPassword.called).to.equal(false)
    expect(stubs.saveDbRootPassword.called).to.equal(false)
}

describe('DatabaseService', function () {
    describe('askMariadbRootPassword() when the container id lookup fails', function () {

        it('refuses the env override, saving nothing, when docker answers unknown', async function () {
            expectRefusedWithNothingSaved(await resolveWithPresence({ presence: 'unknown', envPassword: 'env-root-pass' }), 'unknown')
        })

        it('refuses the env override when a container exists but its id could not be resolved', async function () {
            expectRefusedWithNothingSaved(await resolveWithPresence({ presence: 'exists', envPassword: 'env-root-pass' }), 'exists')
        })

        it('refuses on a TTY instead of prompting for a new password to set', async function () {
            expectRefusedWithNothingSaved(await resolveWithPresence({ presence: 'unknown', tty: true }), 'unknown')
        })

        it('treats a presence probe that throws as unknown', async function () {
            expectRefusedWithNothingSaved(await resolveWithPresence({ presenceThrows: true, envPassword: 'env-root-pass' }), 'unknown')
        })

        it('still takes the fresh-install path once docker confirms the container is gone', async function () {
            const { stubs, err, result } = await resolveWithPresence({ presence: 'gone', envPassword: 'env-root-pass' })
            expect(err).to.equal(null)
            expect(result).to.equal('env-root-pass')
            expect(stubs.saveDbRootPassword.calledWith('env-root-pass')).to.equal(true)
        })
    })
})
